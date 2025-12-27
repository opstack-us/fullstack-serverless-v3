const fs = require('fs');
const path = require('path');

const BbPromise = require('bluebird');
const mime = require('mime');

const getFileList = require('./utilities/getFileList');

/**
 * Uploads client files to an S3 bucket
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be configured
 * @param {string} clientRoot - Full path to the root directory of client files
 * @param {Object[]} headerSpec - Array of header values to add to files
 * @param {Object} logger - Optional logger instance
 */
function uploadDirectory(aws, bucketName, clientRoot, headerSpec, logger = null) {
    if (logger) {
        logger.startTimer('uploadDirectory');
        logger.verbose(`Scanning directory: ${clientRoot}`);
    }
    
    const allFiles = getFileList(clientRoot);
    
    if (logger) {
        logger.verbose(`Found ${allFiles.length} file(s) to upload`);
    }

    const uploadList = buildUploadList(allFiles, clientRoot, headerSpec, logger);
    
    if (logger) {
        logger.info(`Uploading ${uploadList.length} file(s) to bucket '${bucketName}'...`);
    }

    let completed = 0;
    const total = uploadList.length;

    return BbPromise.all(
        uploadList.map((u, index) => {
            return uploadFile(aws, bucketName, u.filePath, u.fileKey, u.headers, logger)
                .then(result => {
                    completed++;
                    if (logger) {
                        logger.progress('Upload', completed, total, u.fileKey);
                    }
                    return result;
                });
        })
    ).then(results => {
        if (logger) {
            const elapsed = logger.endTimer('uploadDirectory');
            logger.success(`Uploaded ${total} file(s) successfully (${logger.formatTime(elapsed)})`);
        }
        return results;
    });
}

/**
 * Uploads a file to an S3 bucket
 * @param {Object} aws - AWS class
 * @param {string} bucketName - Name of bucket to be configured
 * @param {string} filePath - Full path to file to be uploaded
 * @param {string} fileKey - S3 key for the file
 * @param {Object} headers - Headers to apply to the file
 * @param {Object} logger - Optional logger instance
 */
function uploadFile(aws, bucketName, filePath, fileKey, headers, logger = null) {
    let baseHeaderKeys = [
        'Cache-Control',
        'Content-Disposition',
        'Content-Encoding',
        'Content-Language',
        'Content-Type',
        'Expires',
        'Website-Redirect-Location'
    ];

    const fileBuffer = fs.readFileSync(filePath);
    const fileSize = fileBuffer.length;
    const contentType = mime.lookup(filePath);

    let params = {
        Bucket: bucketName,
        Key: fileKey,
        Body: fileBuffer,
        ContentType: contentType
    };

    Object.keys(headers).forEach(h => {
        if (baseHeaderKeys.includes(h)) {
            params[h.replace('-', '')] = headers[h];
        } else {
            if (!params.Metadata) {
                params.Metadata = {};
            }
            params.Metadata[h] = headers[h];
        }
    });

    if (logger && logger.isDebug()) {
        logger.debug(`Uploading file: ${fileKey}`, {
            size: `${(fileSize / 1024).toFixed(2)} KB`,
            contentType,
            headers: Object.keys(headers).length > 0 ? Object.keys(headers) : 'none'
        });
    }

    return aws.request('S3', 'putObject', params).then(resp => {
        if (logger && logger.isDebug()) {
            logger.logAwsResponse('S3', 'putObject', resp);
        }
        return resp;
    });
}

function buildUploadList(files, clientRoot, headerSpec, logger = null) {
    clientRoot = path.normalize(clientRoot);
    if (!clientRoot.endsWith(path.sep)) {
        clientRoot += path.sep;
    }

    if (logger) {
        logger.verbose(`Building upload list from ${files.length} file(s)`);
        if (headerSpec) {
            const specKeys = Object.keys(headerSpec);
            logger.verbose(`Applying header specifications: ${specKeys.length} rule(s)`);
        }
    }

    const uploadList = files.map(f => {
        const filePath = path.normalize(f);
        const fileRelPath = filePath.replace(clientRoot, '');
        const fileKey = path
            .normalize(fileRelPath)
            .split(path.sep)
            .join('/');

        let upload = {
            filePath: filePath,
            fileKey: fileKey,
            headers: {}
        };

        if (!headerSpec) {
            return upload;
        }

        // add bucket-wide headers
        if (headerSpec.ALL_OBJECTS) {
            headerSpec.ALL_OBJECTS.forEach(h => {
                upload.headers[h.name] = h.value;
            });
        }

        // add folder-level headers
        Object.keys(headerSpec)
            .filter(s => s.endsWith(path.sep)) // folders
            .sort((a, b) => a.length > b.length) // sort by length ascending
            .forEach(s => {
                if (fileRelPath.startsWith(path.normalize(s))) {
                    headerSpec[s].forEach(h => {
                        upload.headers[h.name] = h.value;
                    });
                }
            });

        // add file-specific headers
        Object.keys(headerSpec)
            .filter(s => {
                return path.normalize(s) === fileRelPath;
            })
            .forEach(s => {
                headerSpec[s].forEach(h => {
                    upload.headers[h.name] = h.value;
                });
            });

        return upload;
    });

    if (logger) {
        const filesWithHeaders = uploadList.filter(u => Object.keys(u.headers).length > 0).length;
        logger.verbose(`Upload list built: ${uploadList.length} file(s), ${filesWithHeaders} with custom headers`);
    }

    return uploadList;
}

module.exports = uploadDirectory;
