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
 * Get a list of all objects in an S3 bucket (with pagination support)
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to scan
 * @param {Object} logger - Optional logger instance
 * @returns {Promise<Array>} - Array of all objects in the bucket
 */
function listObjectsInBucket(aws, bucketName, logger = null) {
    let allObjects = [];
    let continuationToken = null;
    let pageCount = 0;
    
    const fetchPage = (token) => {
        let params = {
            Bucket: bucketName,
            MaxKeys: 1000 // Maximum allowed by S3
        };
        
        if (token) {
            params.ContinuationToken = token;
        }
        
        if (logger && pageCount === 0) {
            logger.logAwsRequest('S3', 'listObjectsV2', { Bucket: bucketName, MaxKeys: 1000 });
        }
        
        return aws.request('S3', 'listObjectsV2', params).then(resp => {
            pageCount++;
            
            if (resp.Contents && resp.Contents.length > 0) {
                allObjects = allObjects.concat(resp.Contents);
                if (logger) {
                    logger.verbose(`Fetched page ${pageCount}: ${resp.Contents.length} object(s) (total so far: ${allObjects.length})`);
                }
            }
            
            // Check if there are more pages
            if (resp.IsTruncated && resp.NextContinuationToken) {
                return fetchPage(resp.NextContinuationToken);
            } else {
                // All pages fetched
                if (logger) {
                    logger.verbose(`Found ${allObjects.length} total object(s) in bucket '${bucketName}' (${pageCount} page(s))`);
                }
                return { Contents: allObjects };
            }
        });
    };
    
    return fetchPage(null);
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
 * Deletes all objects in an S3 bucket (handles large buckets with pagination)
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be deleted
 * @param {Object} logger - Optional logger instance
 */
function emptyBucket(aws, bucketName, logger = null) {
    if (logger) {
        logger.startTimer('emptyBucket');
        logger.info(`Scanning bucket '${bucketName}' for objects to delete...`);
    }
    
    return listObjectsInBucket(aws, bucketName, logger).then(resp => {
        const contents = resp.Contents;

        if (!contents || contents.length === 0) {
            if (logger) {
                logger.verbose(`Bucket '${bucketName}' is already empty`);
                logger.endTimer('emptyBucket');
            }
            return BbPromise.resolve();
        } else {
            const objectCount = contents.length;
            if (logger) {
                logger.info(`Found ${objectCount} object(s) to delete from bucket '${bucketName}'`);
            }
            
            // S3 deleteObjects can only delete up to 1000 objects per request
            // Split into batches of 1000
            const batchSize = 1000;
            const batches = [];
            
            for (let i = 0; i < contents.length; i += batchSize) {
                const batch = contents.slice(i, i + batchSize);
                const objects = _.map(batch, function (content) {
                    return _.pick(content, 'Key');
                });
                batches.push(objects);
            }
            
            if (logger) {
                logger.info(`Deleting in ${batches.length} batch(es) of up to ${batchSize} object(s) each...`);
            }
            
            // Delete all batches in parallel (but each batch is sequential)
            return BbPromise.map(batches, (objects, index) => {
                const params = {
                    Bucket: bucketName,
                    Delete: { Objects: objects }
                };

                if (logger) {
                    const batchNum = index + 1;
                    const batchSize = objects.length;
                    logger.verbose(`Deleting batch ${batchNum}/${batches.length} (${batchSize} object(s))...`);
                }

                return aws.request('S3', 'deleteObjects', params).then(resp => {
                    if (resp.Errors && resp.Errors.length > 0) {
                        if (logger) {
                            logger.warn(`Some objects failed to delete: ${resp.Errors.length} error(s)`);
                            resp.Errors.forEach(err => {
                                logger.warn(`  Failed to delete ${err.Key}: ${err.Message}`);
                            });
                        }
                    }
                    return resp;
                });
            }, { concurrency: 10 }).then(() => {
                // All batches deleted
                if (logger) {
                    const elapsed = logger.endTimer('emptyBucket');
                    logger.success(`Successfully deleted ${objectCount} object(s) from bucket '${bucketName}' (${logger.formatTime(elapsed)})`);
                }
                return { deleted: objectCount };
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
