const getCloudFrontDistributionId = async (serverless, logger = null) => {
    const awsClient = serverless.getProvider('aws'),
        requestParams = {
            StackName: awsClient.naming.getStackName()
        };
    
    if (logger) {
        logger.verbose(`Looking up CloudFront distribution ID from stack: ${requestParams.StackName}`);
        logger.logAwsRequest('CloudFormation', 'listStackResources', requestParams);
    }
    
    const listResourcesResponse = await awsClient.request('CloudFormation', 'listStackResources', requestParams);
    
    if (logger) {
        logger.logAwsResponse('CloudFormation', 'listStackResources', listResourcesResponse);
    }
    
    const apiDistribution = listResourcesResponse.StackResourceSummaries
        .find(stack => stack.LogicalResourceId === 'ApiDistribution');

    if (logger) {
        if (apiDistribution) {
            logger.verbose(`Found CloudFront distribution: ${apiDistribution.PhysicalResourceId}`);
        } else {
            logger.verbose(`CloudFront distribution not found in stack resources`);
        }
    }

    return !apiDistribution ? null : apiDistribution.PhysicalResourceId;
};

const invalidateCloudfrontDistribution = async (serverless, invalidationPaths, logger = null) => {
    if (logger) {
        logger.startTimer('cloudFrontInvalidation');
        logger.info(`Starting CloudFront invalidation for ${invalidationPaths.length} path(s)...`);
    }
    
    const distributionId = await getCloudFrontDistributionId(serverless, logger);

    if (!distributionId) {
        if (logger) {
            logger.warn('CloudFront distribution id was not found. Skipping CloudFront invalidation.');
        } else {
            serverless.cli.log('CloudFront distribution id was not found. Skipping CloudFront invalidation.');
        }
        return;
    }

    const awsClient = serverless.getProvider('aws'),
        invalidationParams = {
            DistributionId: distributionId,
            InvalidationBatch: {
                CallerReference: Date.now().toString(),
                Paths: {
                    Quantity: invalidationPaths.length,
                    Items: invalidationPaths
                }
            }
        };
    
    if (logger) {
        logger.verbose(`Invalidating paths: ${invalidationPaths.join(', ')}`);
        logger.logAwsRequest('CloudFront', 'createInvalidation', {
            DistributionId: distributionId,
            PathCount: invalidationPaths.length
        });
    }
    
    const invalidationResponse = await awsClient.request('CloudFront', 'createInvalidation', invalidationParams);
    
    if (logger) {
        logger.logAwsResponse('CloudFront', 'createInvalidation', invalidationResponse);
    }
    
    const invalidationId = invalidationResponse.Invalidation.Id;

    if (logger) {
        logger.info(`CloudFront invalidation started (ID: ${invalidationId})...`);
        logger.verbose(`Waiting for invalidation to complete...`);
    } else {
        serverless.cli.log('CloudFront invalidation started...');
    }

    let checkCount = 0;
    const checkInvalidationStatus = async () => {
        const getInvalidationParams = {
                DistributionId: distributionId,
                Id: invalidationId
            };
        
        if (logger && logger.isDebug()) {
            logger.debug(`Checking invalidation status (attempt ${++checkCount})...`);
            logger.logAwsRequest('CloudFront', 'getInvalidation', getInvalidationParams);
        }
        
        const getInvalidationResponse = await awsClient.request('CloudFront', 'getInvalidation', getInvalidationParams);
        
        if (logger && logger.isDebug()) {
            logger.logAwsResponse('CloudFront', 'getInvalidation', getInvalidationResponse);
            logger.debug(`Invalidation status: ${getInvalidationResponse.Invalidation.Status}`);
        }

        return getInvalidationResponse.Invalidation.Status === 'Completed';
    };
    
    const waitForInvalidation = async (resolve) => {
        const isInvalidationComplete = await checkInvalidationStatus();

        if (isInvalidationComplete) {
            resolve();
        } else {
            setTimeout(waitForInvalidation, 1000, resolve);
        }
    };

    await new Promise(resolve => waitForInvalidation(resolve));

    if (logger) {
        const elapsed = logger.endTimer('cloudFrontInvalidation');
        logger.success(`CloudFront invalidation completed (${logger.formatTime(elapsed)})`);
    } else {
        serverless.cli.log('CloudFront invalidation completed.');
    }
};

module.exports = invalidateCloudfrontDistribution;
