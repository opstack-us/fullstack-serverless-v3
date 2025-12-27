const _ = require('lodash');
const BbPromise = require('bluebird');

/**
 * Checks if an S3 bucket exists
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to look for
 * @param {Object} logger - Optional logger instance
 *
 * @returns {Promise<boolean>}
 */
function bucketExists(aws, bucketName, logger = null) {
    if (logger) {
        logger.logAwsRequest('S3', 'listBuckets', {});
    }
    
    return aws.request('S3', 'listBuckets', {}).then(resp => {
        if (logger) {
            logger.logAwsResponse('S3', 'listBuckets', resp);
            logger.verbose(`Checking for bucket '${bucketName}' in ${resp.Buckets.length} bucket(s)`);
        }
        
        let exists = false;
        resp.Buckets.forEach(bucket => {
            if (bucket.Name === bucketName) {
                exists = true;
            }
        });
        
        if (logger) {
            logger.debug(`Bucket '${bucketName}' ${exists ? 'found' : 'not found'}`);
        }
        
        return exists;
    });
}

/**
 * Get a list of all objects in an S3 bucket
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to scan
 * @param {Object} logger - Optional logger instance
 */
function listObjectsInBucket(aws, bucketName, logger = null) {
    let params = {
        Bucket: bucketName
    };
    
    if (logger) {
        logger.logAwsRequest('S3', 'listObjectsV2', params);
    }
    
    return aws.request('S3', 'listObjectsV2', params).then(resp => {
        if (logger) {
            logger.logAwsResponse('S3', 'listObjectsV2', resp);
            const count = resp.Contents ? resp.Contents.length : 0;
            logger.verbose(`Found ${count} object(s) in bucket '${bucketName}'`);
        }
        return resp;
    });
}

/**
 * Deletes an S3 bucket
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be deleted
 */
function deleteBucket(aws, bucketName) {
    const params = {
        Bucket: bucketName
    };
    return aws.request('S3', 'deleteBucket', params);
}

/**
 * Deletes all objects in an S3 bucket
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be deleted
 * @param {Object} logger - Optional logger instance
 */
function emptyBucket(aws, bucketName, logger = null) {
    if (logger) {
        logger.startTimer('emptyBucket');
    }
    
    return listObjectsInBucket(aws, bucketName, logger).then(resp => {
        const contents = resp.Contents;

        if (!contents || !contents[0]) {
            if (logger) {
                logger.verbose(`Bucket '${bucketName}' is already empty`);
                logger.endTimer('emptyBucket');
            }
            return BbPromise.resolve();
        } else {
            const objectCount = contents.length;
            if (logger) {
                logger.verbose(`Deleting ${objectCount} object(s) from bucket '${bucketName}'`);
            }
            
            const objects = _.map(contents, function (content) {
                return _.pick(content, 'Key');
            });

            const params = {
                Bucket: bucketName,
                Delete: {Objects: objects}
            };

            if (logger) {
                logger.logAwsRequest('S3', 'deleteObjects', { 
                    Bucket: bucketName, 
                    ObjectCount: objectCount 
                });
            }

            return aws.request('S3', 'deleteObjects', params).then(resp => {
                if (logger) {
                    logger.logAwsResponse('S3', 'deleteObjects', resp);
                    const elapsed = logger.endTimer('emptyBucket');
                    logger.verbose(`Successfully deleted ${objectCount} object(s) (${logger.formatTime(elapsed)})`);
                }
                return resp;
            });
        }
    });
}

/**
 * Creates S3 bucket with the given name
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be created
 * @param {Object} logger - Optional logger instance
 */
function createBucket(aws, bucketName, logger = null) {
    const params = {
        Bucket: bucketName
    };

    if (logger) {
        logger.logAwsRequest('S3', 'createBucket', params);
        logger.verbose(`Creating bucket '${bucketName}'`);
    }

    return aws.request('S3', 'createBucket', params).then(resp => {
        if (logger) {
            logger.logAwsResponse('S3', 'createBucket', resp);
            logger.verbose(`Bucket '${bucketName}' created successfully`);
        }
        return resp;
    });
}

module.exports = {
    bucketExists,
    createBucket,
    deleteBucket,
    emptyBucket,
    listObjectsInBucket
};
