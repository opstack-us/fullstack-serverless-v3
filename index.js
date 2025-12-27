const path = require('path');
const _ = require('lodash');
const chalk = require('chalk');
const yaml = require('js-yaml');
const fs = require('fs');
const {spawn} = require('child_process');

const BbPromise = require('bluebird');
const Confirm = require('prompt-confirm');

const bucketUtils = require('./lib/bucketUtils');
const uploadDirectory = require('./lib/upload');
const validateClient = require('./lib/validate');
const invalidateCloudfrontDistribution = require('./lib/cloudFront');
const Logger = require('./lib/utilities/logger');

class ServerlessFullstackPlugin {
    constructor(serverless, cliOptions) {

        this.error = serverless.classes.Error;
        this.serverless = serverless;
        this.options = serverless.service.custom.fullstack;
        this.cliOptions = cliOptions || {};
        this.aws = this.serverless.getProvider('aws');
        
        // Initialize enhanced logger
        this.logger = new Logger(serverless);

        this.hooks = {
            'package:createDeploymentArtifacts': this.createDeploymentArtifacts.bind(this),
            'aws:info:displayStackOutputs': this.printSummary.bind(this),
            'client:client': () => this.serverless.cli.log(this.commands.client.usage),
            'before:client:deploy:deploy': this.generateClient.bind(this),
            'client:deploy:deploy': this.processDeployment.bind(this),
            'client:remove:remove': this.removeDeployedResources.bind(this),
            'after:aws:deploy:deploy:updateStack': () => this.serverless.pluginManager.run(['client', 'deploy']),
            'before:remove:remove': () => this.serverless.pluginManager.run(['client', 'remove']),
            'before:aws:package:finalize:mergeCustomProviderResources': this.checkForApiGataway.bind(this)
        };

        this.commands = {
            client: {
                usage: 'Generate and deploy clients',
                lifecycleEvents: ['client', 'deploy'],
                commands: {
                    deploy: {
                        usage: 'Deploy serverless client code',
                        lifecycleEvents: ['deploy']
                    },
                    remove: {
                        usage: 'Removes deployed files and bucket',
                        lifecycleEvents: ['remove']
                    }
                }
            }
        };
    }

    validateConfig() {
        this.logger.verbose('Validating fullstack configuration...');
        try {
            validateClient(this.serverless, this.options, this.logger);
            this.logger.verbose('Configuration validation passed');
        } catch (e) {
            this.logger.error('Configuration validation failed', e);
            return BbPromise.reject(`Fullstack serverless configuration errors:\n- ${e.join('\n- ')}`);
        }
        return BbPromise.resolve();
    }

    removeDeployedResources() {
        let bucketName;

        return this.logger.logOperation('removeDeployedResources', async () => {
            return this.validateConfig()
                .then(() => {
                    bucketName = this.getBucketName(this.options.bucketName);
                    this.logger.verbose(`Target bucket: ${bucketName}`);
                    return (this.getCLIOptions('confirm') === false || this.options.noConfirm === true) ? true : new Confirm(`Are you sure you want to delete bucket '${bucketName}'?`).run();
                })
                .then(goOn => {
                    if (goOn) {
                        this.logger.info(`Looking for bucket '${bucketName}'...`);
                        return bucketUtils.bucketExists(this.aws, bucketName, this.logger).then(exists => {
                            if (exists) {
                                this.logger.info(`Deleting all objects from bucket...`);
                                return bucketUtils
                                    .emptyBucket(this.aws, bucketName, this.logger)
                                    .then(() => {
                                        this.logger.success(`Your client files have been removed`);
                                    });
                            } else {
                                this.logger.warn(`Bucket '${bucketName}' does not exist`);
                            }
                        });
                    }
                    this.logger.info('Bucket removal cancelled');
                    return BbPromise.resolve();
                })
                .catch(error => {
                    this.logger.error('Failed to remove deployed resources', error);
                    return BbPromise.reject(new this.error(error));
                });
        });
    }

    setClientEnv() {
        this.logger.verbose(`Setting the environment variables...`);
        const serverlessEnv = this.serverless.service.provider.environment;

        if (!serverlessEnv) {
          this.logger.verbose(`No environment variables detected. Skipping step...`);
          return {};
        }

        const envCount = Object.keys(serverlessEnv).length;
        this.logger.verbose(`Found ${envCount} environment variable(s) to set`);
        if (this.logger.isDebug()) {
            this.logger.debug('Environment variables', Object.keys(serverlessEnv));
        }

        return Object.assign({}, process.env, serverlessEnv);
    }

    generateClient() {
        const clientCommand = this.options.clientCommand;
        const clientSrcPath = this.options.clientSrcPath || '.';
        if (clientCommand && this.getCLIOptions('generate-client') !== false) {
            const args = clientCommand.split(' ');
            const command = args.shift();
            this.logger.verbose(`Client command: ${command}`, { args, clientSrcPath });
            return new BbPromise(this.performClientGeneration.bind(this, command, args, clientSrcPath));

        } else {
            this.logger.verbose(`Skipping client generation...`);
        }

        return BbPromise.resolve();
    }

    performClientGeneration(command, args, clientSrcPath, resolve, reject) {
        this.logger.startTimer('clientGeneration');
        this.logger.info(`Generating client...`);
        this.logger.verbose(`Running: ${command} ${args.join(' ')}`);
        this.logger.verbose(`Working directory: ${clientSrcPath}`);
        
        const clientEnv = this.setClientEnv();
        const proc = spawn(command, args, {cwd: clientSrcPath, env: clientEnv, shell: true});

        proc.stdout.on('data', (data) => {
            const printableData = data ? `${data}`.trim() : '';
            if (printableData) {
                this.logger.verbose(`Client build output: ${printableData}`);
            }
        });

        proc.stderr.on('data', (data) => {
            const printableData = data ? `${data}`.trim() : '';
            if (printableData) {
                this.logger.verbose(`Client build stderr: ${printableData}`);
            }
        });

        proc.on('close', (code) => {
            const elapsed = this.logger.endTimer('clientGeneration');
            if (code === 0) {
                this.logger.success(`Client generation succeeded (${this.logger.formatTime(elapsed)})`);
                resolve();
            } else {
                this.logger.error(`Client generation failed with exit code ${code} (${this.logger.formatTime(elapsed)})`);
                reject(new this.error(`Client generation failed with code ${code}`));
            }
        });
    }

    processDeployment() {

        if(this.getCLIOptions('client-deploy') !== false) {
            let region,
                distributionFolder,
                clientPath,
                bucketName,
                headerSpec,
                indexDoc,
                errorDoc,
                invalidationPaths;

            return this.logger.logOperation('processDeployment', async () => {
                return this.validateConfig()
                    .then(() => {
                        // region is set based on the following order of precedence:
                        // If specified, the CLI option is used
                        // If region is not specified via the CLI, we use the region option specified
                        //   under custom/client in serverless.yml
                        // Otherwise, use the Serverless region specified under provider in serverless.yml
                        region =
                            this.cliOptions.region ||
                            this.options.region ||
                            _.get(this.serverless, 'service.provider.region');

                        distributionFolder = this.options.distributionFolder || path.join('client/dist');
                        clientPath = path.join(this.serverless.config.servicePath, distributionFolder);
                        bucketName = this.getBucketName(this.options.bucketName);
                        headerSpec = this.options.objectHeaders;
                        indexDoc = this.options.indexDocument || "index.html";
                        errorDoc = this.options.errorDocument || "error.html";
                        invalidationPaths = this.options.invalidationPaths || ['/*'];

                        if (!Array.isArray(invalidationPaths)) {
                            invalidationPaths = [invalidationPaths];
                        }
                        
                        //paths must start with '/'
                        invalidationPaths = invalidationPaths.map(path => path[0] === '/' ? path : '/' + path);

                        this.logger.verbose('Deployment configuration', {
                            region,
                            distributionFolder,
                            clientPath,
                            bucketName,
                            indexDoc,
                            errorDoc,
                            invalidationPaths: invalidationPaths.length
                        });

                        const deployDescribe = ['This deployment will:'];

                        if (this.getCLIOptions('delete-contents') !== false) {
                            deployDescribe.push(`- Remove all existing files from bucket '${bucketName}'`);
                        }
                        deployDescribe.push(
                            `- Upload all files from '${distributionFolder}' to bucket '${bucketName}'`
                        );

                        deployDescribe.forEach(m => this.logger.info(m));
                        return (this.getCLIOptions('confirm') === false || this.options.noConfirm === true) ? true : new Confirm(`Do you want to proceed?`).run();
                    })
                    .then(goOn => {
                        if (goOn) {
                            this.logger.info(`Looking for bucket '${bucketName}'...`);
                            return bucketUtils
                                .bucketExists(this.aws, bucketName, this.logger)
                                .then(exists => {
                                    if (exists) {
                                        this.logger.info(`Bucket found...`);
                                        if (this.getCLIOptions('delete-contents') === false) {
                                            this.logger.info(`Keeping current bucket contents...`);
                                            return BbPromise.resolve();
                                        }

                                        this.logger.info(`Deleting all objects from bucket...`);
                                        return bucketUtils.emptyBucket(this.aws, bucketName, this.logger);
                                    } else {
                                        this.logger.error(`Bucket does not exist. Run ${chalk.black('serverless deploy')}`);
                                        return BbPromise.reject('Bucket does not exist!');
                                    }
                                })
                                .then(() => {
                                    this.logger.info(`Preparing to upload client files to bucket '${bucketName}'...`);
                                    return uploadDirectory(this.aws, bucketName, clientPath, headerSpec, this.logger);
                                })
                                .then(() => {
                                    this.logger.success(`Client deployed successfully`);
                                });
                        }
                        this.logger.info('Client deployment cancelled');
                        return BbPromise.resolve();
                    })
                    .then(() => {
                        if (this.getCLIOptions('invalidate-distribution') === false) {
                            this.logger.verbose(`Skipping cloudfront invalidation...`);
                        } else {
                            return invalidateCloudfrontDistribution(this.serverless, invalidationPaths, this.logger);
                        }
                    })
                    .catch(error => {
                        this.logger.error('Deployment failed', error);
                        return BbPromise.reject(new this.error(error));
                    });
            });
        } else {
            this.logger.verbose(`Skipping client deployment...`);
        }
    }

    createDeploymentArtifacts() {
        const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;

        const filename = path.resolve(__dirname, 'lib/resources/resources.yml');
        const content = fs.readFileSync(filename, 'utf-8');
        const resources = yaml.safeLoad(content, {
            filename: filename
        });

        this.prepareResources(resources);
        return _.merge(baseResources, resources);
    }

    checkForApiGataway() {
        const baseResources = this.serverless.service.provider.compiledCloudFormationTemplate;
        const apiGatewayConfig = baseResources.Resources.ApiGatewayRestApi;

        if (!apiGatewayConfig && !this.setApiGatewayIdFromConfig(baseResources)) {
            this.removeApiGatewayOrigin(baseResources);
        }

        return baseResources;
    }

    removeApiGatewayOrigin(baseResources) {
        this.logger.verbose(`ApiGatewayRestApi not found, removing origin from CloudFront...`);
        const distributionConfig = baseResources.Resources.ApiDistribution.Properties.DistributionConfig;
        distributionConfig.Origins = _.filter(distributionConfig.Origins, (origin => {
            return origin.Id !== 'ApiGateway';
        }));
        distributionConfig.CacheBehaviors = _.filter(distributionConfig.CacheBehaviors, (cacheBehavior => {
            return cacheBehavior.TargetOriginId !== 'ApiGateway';
        }));
    }

    setApiGatewayIdFromConfig(baseResources) {
        const restApiId = this.getRestApiId();

        if (!restApiId) {
            return false;
        }

        const distributionConfig = baseResources.Resources.ApiDistribution.Properties.DistributionConfig;
        const apiOrigin = distributionConfig.Origins.find(origin => origin.Id === 'ApiGateway');

        apiOrigin.DomainName = {
            'Fn::Join': ['', [restApiId, '.execute-api.', {
                Ref: 'AWS::Region'
            }, '.amazonaws.com']]
        };

        return true;
    }

    getRestApiId() {
        const apiGatewaySection = this.serverless.service.provider.apiGateway;

        if (apiGatewaySection && apiGatewaySection.restApiId) {
            return apiGatewaySection.restApiId;
        }

        return this.getConfig('apiGatewayRestApiId', null);
    }

    printSummary() {
        const awsInfo = _.find(this.serverless.pluginManager.getPlugins(), (plugin) => {
            return plugin.constructor.name === 'AwsInfo';
        });

        if (!awsInfo || !awsInfo.gatheredData) {
            return;
        }

        const outputs = awsInfo.gatheredData.outputs;
        const apiDistributionDomain = _.find(outputs, (output) => {
            return output.OutputKey === 'ApiDistribution';
        });

        if (!apiDistributionDomain || !apiDistributionDomain.OutputValue) {
            return;
        }

        const cnameDomain = this.getConfig('domain', '-');

        this.serverless.cli.consoleLog(chalk.yellow('CloudFront domain name'));
        this.serverless.cli.consoleLog(`  ${apiDistributionDomain.OutputValue} (CNAME: ${cnameDomain})`);
    }

    prepareResources(resources) {
        const distributionConfig = resources.Resources.ApiDistribution.Properties.DistributionConfig;

        this.prepareLogging(distributionConfig);
        this.prepareDomain(distributionConfig);
        this.preparePriceClass(distributionConfig);
        this.prepareOrigins(distributionConfig);
        this.preparePathPattern(distributionConfig);
        this.prepareComment(distributionConfig);
        this.prepareCertificate(distributionConfig);
        this.prepareWaf(distributionConfig);
        this.prepareSinglePageApp(resources.Resources);
        this.prepareS3(resources.Resources);
        this.prepareMinimumProtocolVersion(distributionConfig);
        this.prepareDefaultCacheBehavior(distributionConfig);
        this.prepareAliases(resources.Resources);

    }


    prepareLogging(distributionConfig) {
        const loggingBucket = this.getConfig('logging.bucket', null);

        if (loggingBucket !== null) {
            const prefix = this.getConfig('logging.prefix', '');
            this.logger.verbose(`Setting up CloudFront logging bucket: ${loggingBucket}`, { prefix });
            distributionConfig.Logging.Bucket = loggingBucket;
            distributionConfig.Logging.Prefix = prefix;

        } else {
            this.logger.verbose(`Removing logging bucket configuration...`);
            delete distributionConfig.Logging;
        }
    }

    prepareDomain(distributionConfig) {
        const domain = this.getConfig('domain', null);

        if (domain !== null) {
            var localDomain;
            try {
                localDomain = domain.split(',');
            } catch (e) {
                localDomain = domain;
            }
            const domains = Array.isArray(localDomain) ? localDomain : [localDomain];
            this.logger.verbose(`Adding domain alias(es): ${domains.join(', ')}`);
            distributionConfig.Aliases = domains;
        } else {
            this.logger.verbose(`No custom domain configured, using default CloudFront domain`);
            delete distributionConfig.Aliases;
        }
    }
    
    prepareAliases(resources) {
        const route53Id = this.getConfig('route53Id', null);
        const route53Domain = this.getConfig('route53Domain', null);
        
        if (!route53Id || !route53Domain) {
            this.logger.verbose(`Route53 configuration not provided, skipping DNS record creation`);
            return;
        }
        
        const aliases = resources.ApiDistribution.Properties.DistributionConfig.Aliases || [];
        let recordCount = 0;
        
        for (let i = 0; i < aliases.length; i++) {
            var alias = aliases[i];
            // Alias is in the hosted zone domain, so we can add this record.
            if (alias.endsWith('.'+route53Domain)) {
                var name = i==0 ? "" : i;
                resources["PublicDNS"+name] = {
                  "Type" : "AWS::Route53::RecordSet",
                  "Properties" : {
                      "HostedZoneId" : route53Id,
                      "Name" : alias,
                      "ResourceRecords" : [ {'Fn::GetAtt': ["ApiDistribution", "DomainName"]} ],
                      "TTL" : "900",
                      "Type" : "CNAME"
                    }
                }
                recordCount++;
            }
        }
        
        if (recordCount > 0) {
            this.logger.verbose(`Creating ${recordCount} Route53 DNS record(s) for CloudFront aliases`);
        } else {
            this.logger.verbose(`No Route53 DNS records needed (aliases not in hosted zone domain)`);
        }
    }

    preparePriceClass(distributionConfig) {
        const priceClass = this.getConfig('priceClass', 'PriceClass_All');
        this.logger.verbose(`Setting CloudFront price class: ${priceClass}`);
        distributionConfig.PriceClass = priceClass;
    }

    prepareOrigins(distributionConfig) {
        const stage = this.getStage();
        this.logger.verbose(`Setting ApiGateway stage to '${stage}'...`);
        for (var origin of distributionConfig.Origins) {
            if (origin.Id === 'ApiGateway') {
                origin.OriginPath = `/${stage}`;
            }
        }
        
        const customOrigins = this.getConfig('origins', null);
        if (customOrigins) {
            this.logger.verbose(`Adding ${customOrigins.length} custom origin(s)`);
            distributionConfig.Origins.push(
                ...customOrigins
            );
        }
    }

    preparePathPattern(distributionConfig) {
        const customCacheBehaviors = this.getConfig('cacheBehaviors', null);
        if (customCacheBehaviors) {
            this.logger.verbose(`Configuring ${customCacheBehaviors.length} custom cache behavior(s)`);
            for (let customCacheBehavior of customCacheBehaviors) {
                for (let cacheBehavior of distributionConfig.CacheBehaviors) {
                    if (cacheBehavior.TargetOriginId === customCacheBehavior.TargetOriginId) {
                        let index = distributionConfig.CacheBehaviors.indexOf(cacheBehavior);
                        distributionConfig.CacheBehaviors.splice(index, 1);
                    }
                }
            }
            
            distributionConfig.CacheBehaviors.push(
                ...customCacheBehaviors
            );
        }
        
        const apiPath = this.getConfig('apiPath', 'api');
        this.logger.verbose(`Setting API path prefix to '${apiPath}'...`);
        for (let cacheBehavior of distributionConfig.CacheBehaviors) {
            if (cacheBehavior.TargetOriginId === 'ApiGateway') {
                cacheBehavior.PathPattern = `${apiPath}/*`;
            }
        }
    }

    prepareComment(distributionConfig) {
        const name = this.serverless.getProvider('aws').naming.getApiGatewayName();
        this.logger.verbose(`Setting CloudFront distribution comment: Serverless Managed ${name}`);
        distributionConfig.Comment = `Serverless Managed ${name}`;
    }

    prepareCertificate(distributionConfig) {
        const certificate = this.getConfig('certificate', null);

        if (certificate !== null) {
            this.logger.verbose(`Configuring SSL certificate: ${certificate}`);
            distributionConfig.ViewerCertificate.AcmCertificateArn = certificate;
        } else {
            this.logger.verbose(`No SSL certificate configured, using default CloudFront certificate`);
            delete distributionConfig.ViewerCertificate;
        }
    }

    prepareMinimumProtocolVersion(distributionConfig) {
        const minimumProtocolVersion = this.getConfig('minimumProtocolVersion', undefined);

        if (minimumProtocolVersion) {
            this.logger.verbose(`Setting minimum SSL/TLS protocol version: ${minimumProtocolVersion}`);
            distributionConfig.ViewerCertificate.MinimumProtocolVersion = minimumProtocolVersion;
        } else {
            this.logger.verbose(`Using default minimum SSL/TLS protocol version`);
        }
    }

    prepareWaf(distributionConfig) {
        const waf = this.getConfig('waf', null);

        if (waf !== null) {
            this.logger.verbose(`Enabling web application firewall: ${waf}`);
            distributionConfig.WebACLId = waf;
        } else {
            this.logger.verbose(`Web application firewall not configured`);
            delete distributionConfig.WebACLId;
        }
    }

    prepareSinglePageApp(resources) {
        const distributionConfig = resources.ApiDistribution.Properties.DistributionConfig;
        const isSinglePageApp = this.getConfig('singlePageApp', false);
        if (isSinglePageApp) {
            this.logger.verbose(`Configuring distribution for single page web app...`);
            const indexDocument = this.getConfig('indexDocument', 'index.html')
            for (let errorResponse of distributionConfig.CustomErrorResponses) {
                if (errorResponse.ErrorCode === '403') {
                    errorResponse.ResponsePagePath = `/${indexDocument}`;
                }
            }

            // Cloudfront default root object
            distributionConfig.DefaultRootObject = indexDocument;

            // Remove public read access to bucket, as all access is through the API for single page apps
            const statements = resources.WebAppS3BucketPolicy.Properties.PolicyDocument.Statement;
            resources.WebAppS3BucketPolicy.Properties.PolicyDocument.Statement = _.filter(statements, (statement) => {
                return statement.Sid !== 'AllowPublicRead';
            });

            for (let origin of distributionConfig.Origins) {
                if (origin.Id === 'WebApp') {
                    delete origin.CustomOriginConfig;
                }
            }
        } else {
            delete distributionConfig.CustomErrorResponses;
            delete resources.S3OriginAccessIdentity;

            // Remove API access to S3 bucket since all content will be served through http
            const statements = resources.WebAppS3BucketPolicy.Properties.PolicyDocument.Statement;
            resources.WebAppS3BucketPolicy.Properties.PolicyDocument.Statement = _.filter(statements, (statement) => {
                return statement.Sid !== 'OAIGetObject';
            });


            for (let origin of distributionConfig.Origins) {
                if (origin.Id === 'WebApp') {
                    delete origin.S3OriginConfig;
                    origin.DomainName = {
                        // Select hostname
                        "Fn::Select": ["1",
                            {
                                // Split URL into protocol and hostname
                                "Fn::Split": ["://",
                                    {
                                        // Get the bucket URL
                                        'Fn::GetAtt': ["WebAppS3Bucket", "WebsiteURL"]
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        }
    }

    prepareS3(resources) {
        const bucketName = this.getConfig('bucketName', null);

        if (bucketName !== null) {
            const stageBucketName = this.getBucketName(bucketName);
            this.logger.verbose(`Setting up S3 bucket: '${stageBucketName}'`);
            resources.WebAppS3Bucket.Properties.BucketName = stageBucketName;
            resources.WebAppS3BucketPolicy.Properties.Bucket = stageBucketName;
        } else {
            this.logger.verbose(`Setting up S3 bucket: '${resources.WebAppS3Bucket.Properties.BucketName}'`);
        }

        const indexDocument = this.getConfig('indexDocument', 'index.html');
        const errorDocument = this.getConfig('errorDocument', 'error.html');

        this.logger.verbose(`Setting indexDocument to '${indexDocument}'`);
        this.logger.verbose(`Setting errorDocument to '${errorDocument}'`);

        resources.WebAppS3Bucket.Properties.WebsiteConfiguration.IndexDocument = indexDocument;
        resources.WebAppS3Bucket.Properties.WebsiteConfiguration.ErrorDocument = errorDocument;
    }

    prepareDefaultCacheBehavior(distributionConfig) {
        const defaultCacheBehavior = this.getConfig('defaultCacheBehavior', {})
        const compressWebContent = this.getConfig('compressWebContent', true);

        this.logger.verbose(`Configuring default cache behavior`, {
            compressWebContent,
            hasCustomBehavior: Object.keys(defaultCacheBehavior).length > 0
        });

        distributionConfig.DefaultCacheBehavior = Object.assign({},
            distributionConfig.DefaultCacheBehavior,
            defaultCacheBehavior,
            { Compress: compressWebContent }
        );
    }

    getBucketName(bucketName) {
        const stageBucketName = `${this.serverless.service.service}-${this.getStage()}-${bucketName}`;
        return stageBucketName;
    }

    getConfig(field, defaultValue) {
        return _.get(this.serverless, `service.custom.fullstack.${field}`, defaultValue)
    }

    getStage() {
        // find the correct stage name
        var stage = this.serverless.service.provider.stage;
        if (this.cliOptions && this.cliOptions.stage) {
            stage = this.cliOptions.stage;
        }
        return stage;
    }

    /**
     * Serverless v3 hotfix/compat.
     * @param {the cli option} param 
     * @returns Boolean
     */
    getCLIOptions(param) {
      // v3
      const isv3 = this.serverless.version.split('.')[0] === '3';
      if (isv3) {
        const cliOptionsParams = Array.isArray(this.cliOptions?.param) ? [...this.cliOptions.param] : [];
        const cliOptions = {...this.cliOptions}

        // Build key/value cli options from param array
        cliOptionsParams.forEach((k) => {
          const key = k.replace('no-', '');
          const val = !k.includes('no');
          cliOptions[key] = val;
        });
        return cliOptions[param]
      }

      // v2
      return this.cliOptions[param]
    }
}

module.exports = ServerlessFullstackPlugin;