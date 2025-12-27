const chalk = require('chalk');

/**
 * Enhanced logging utility for the fullstack-serverless plugin
 * Supports different log levels: info, verbose, debug, error, warn
 * Automatically detects Serverless Framework verbose/debug flags
 */
class Logger {
    constructor(serverless) {
        this.serverless = serverless;
        this.cliOptions = serverless.cliOptions || {};
        
        // Determine log level based on Serverless CLI options
        this.logLevel = this.determineLogLevel();
        
        // Track operation start times for timing information
        this.timers = new Map();
    }

    /**
     * Determine the current log level based on Serverless CLI options
     * @returns {string} - One of: 'debug', 'verbose', 'info'
     */
    determineLogLevel() {
        // Check for Serverless v3 debug/verbose flags
        if (this.cliOptions.debug || this.cliOptions.verbose) {
            return 'debug';
        }
        
        // Check for Serverless v2 style flags
        if (this.cliOptions.v || this.cliOptions.verbose) {
            return 'verbose';
        }
        
        // Check if verbose is set in param array (v3 style)
        if (Array.isArray(this.cliOptions.param)) {
            const hasVerbose = this.cliOptions.param.some(p => 
                p === 'verbose' || p === 'debug' || p === 'v'
            );
            if (hasVerbose) {
                return 'verbose';
            }
        }
        
        return 'info';
    }

    /**
     * Check if verbose logging is enabled
     * @returns {boolean}
     */
    isVerbose() {
        return this.logLevel === 'verbose' || this.logLevel === 'debug';
    }

    /**
     * Check if debug logging is enabled
     * @returns {boolean}
     */
    isDebug() {
        return this.logLevel === 'debug';
    }

    /**
     * Start a timer for an operation
     * @param {string} operation - Name of the operation
     */
    startTimer(operation) {
        this.timers.set(operation, Date.now());
    }

    /**
     * End a timer and return elapsed time
     * @param {string} operation - Name of the operation
     * @returns {number} - Elapsed time in milliseconds
     */
    endTimer(operation) {
        const startTime = this.timers.get(operation);
        if (!startTime) {
            return null;
        }
        this.timers.delete(operation);
        return Date.now() - startTime;
    }

    /**
     * Format elapsed time for display
     * @param {number} ms - Milliseconds
     * @returns {string}
     */
    formatTime(ms) {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        return `${(ms / 1000).toFixed(2)}s`;
    }

    /**
     * Standard info-level log
     * @param {string} message - Message to log
     * @param {Object} context - Optional context object
     */
    info(message, context = null) {
        this.serverless.cli.log(message);
        if (context && this.isVerbose()) {
            this.verbose(`Context: ${JSON.stringify(context, null, 2)}`);
        }
    }

    /**
     * Verbose-level log (only shown when verbose mode is enabled)
     * @param {string} message - Message to log
     * @param {Object} context - Optional context object
     */
    verbose(message, context = null) {
        if (this.isVerbose()) {
            this.serverless.cli.consoleLog(chalk.dim(`  → ${message}`));
            if (context && this.isDebug()) {
                this.debug(`Context: ${JSON.stringify(context, null, 2)}`);
            }
        }
    }

    /**
     * Debug-level log (only shown when debug mode is enabled)
     * @param {string} message - Message to log
     * @param {Object} context - Optional context object
     */
    debug(message, context = null) {
        if (this.isDebug()) {
            this.serverless.cli.consoleLog(chalk.gray(`    [DEBUG] ${message}`));
            if (context) {
                this.serverless.cli.consoleLog(chalk.gray(`    ${JSON.stringify(context, null, 2)}`));
            }
        }
    }

    /**
     * Warning-level log
     * @param {string} message - Message to log
     * @param {Object} context - Optional context object
     */
    warn(message, context = null) {
        this.serverless.cli.consoleLog(chalk.yellow(`⚠ Warning: ${message}`));
        if (context && this.isVerbose()) {
            this.verbose(`Warning context: ${JSON.stringify(context, null, 2)}`);
        }
    }

    /**
     * Error-level log
     * @param {string} message - Message to log
     * @param {Error|Object} error - Error object or context
     */
    error(message, error = null) {
        this.serverless.cli.consoleLog(chalk.red(`✖ Error: ${message}`));
        if (error) {
            if (error instanceof Error) {
                if (this.isVerbose()) {
                    this.verbose(`Error message: ${error.message}`);
                    if (error.stack && this.isDebug()) {
                        this.debug(`Stack trace: ${error.stack}`);
                    }
                }
            } else if (this.isVerbose()) {
                this.verbose(`Error details: ${JSON.stringify(error, null, 2)}`);
            }
        }
    }

    /**
     * Success message
     * @param {string} message - Message to log
     */
    success(message) {
        this.serverless.cli.consoleLog(chalk.green(`✓ ${message}`));
    }

    /**
     * Log an operation with timing
     * @param {string} operation - Name of the operation
     * @param {Function} fn - Function to execute
     * @returns {Promise} - Result of the function
     */
    async logOperation(operation, fn) {
        this.startTimer(operation);
        this.verbose(`Starting: ${operation}`);
        
        try {
            const result = await fn();
            const elapsed = this.endTimer(operation);
            this.verbose(`Completed: ${operation} (${this.formatTime(elapsed)})`);
            return result;
        } catch (error) {
            const elapsed = this.endTimer(operation);
            this.error(`Failed: ${operation} (${this.formatTime(elapsed)})`, error);
            throw error;
        }
    }

    /**
     * Log progress for batch operations
     * @param {string} operation - Name of the operation
     * @param {number} current - Current item number
     * @param {number} total - Total number of items
     * @param {string} itemName - Optional name of current item
     */
    progress(operation, current, total, itemName = null) {
        if (this.isVerbose()) {
            const percentage = Math.round((current / total) * 100);
            const itemInfo = itemName ? ` - ${itemName}` : '';
            this.serverless.cli.consoleLog(
                chalk.dim(`  → ${operation}: ${current}/${total} (${percentage}%)${itemInfo}`)
            );
        } else if (current === total || current % Math.ceil(total / 10) === 0) {
            // Show progress every 10% in non-verbose mode
            const percentage = Math.round((current / total) * 100);
            this.serverless.cli.consoleLog(chalk.dim(`  ${operation}: ${percentage}%`));
        }
    }

    /**
     * Log upload progress with more frequent updates
     * @param {number} current - Current item number
     * @param {number} total - Total number of items
     * @param {string} itemName - Optional name of current item
     * @param {number} lastPercent - Last percentage shown (to avoid duplicates)
     * @returns {number} - Current percentage (to track for next call)
     */
    uploadProgress(current, total, itemName = null, lastPercent = -1) {
        const currentPercent = Math.floor((current / total) * 100);
        
        // For small uploads (< 20 files), show every file. For larger uploads, show every 5% or completion
        const isSmallUpload = total < 20;
        const shouldShow = this.isVerbose() || 
                         current === total || 
                         isSmallUpload ||
                         (currentPercent !== lastPercent && (currentPercent % 5 === 0 || current === total));
        
        if (shouldShow) {
            const percentage = Math.round((current / total) * 100);
            const itemInfo = this.isVerbose() && itemName ? ` - ${itemName}` : '';
            this.serverless.cli.consoleLog(
                chalk.cyan(`  → Upload progress: ${current}/${total} (${percentage}%)${itemInfo}`)
            );
        }
        
        return currentPercent;
    }

    /**
     * Log AWS API request (debug level)
     * @param {string} service - AWS service name
     * @param {string} operation - AWS operation name
     * @param {Object} params - Request parameters
     */
    logAwsRequest(service, operation, params = {}) {
        if (this.isDebug()) {
            this.debug(`AWS ${service}.${operation}`, { params });
        }
    }

    /**
     * Log AWS API response (debug level)
     * @param {string} service - AWS service name
     * @param {string} operation - AWS operation name
     * @param {Object} response - Response data
     */
    logAwsResponse(service, operation, response = {}) {
        if (this.isDebug()) {
            // Don't log full response in debug to avoid clutter, just key info
            const summary = {
                statusCode: response.$metadata?.httpStatusCode,
                requestId: response.$metadata?.requestId
            };
            this.debug(`AWS ${service}.${operation} response`, summary);
        }
    }
}

module.exports = Logger;

