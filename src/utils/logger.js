const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  constructor(level = 'info') {
    this.level = LOG_LEVELS[level] || LOG_LEVELS.info;
    this.prefix = '[BiliBili Auto]';
  }

  _log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logLevel = level.toUpperCase().padEnd(5);
    const logMessage = `${this.prefix} [${timestamp}] ${logLevel}: ${message}`;

    if (LOG_LEVELS[level] >= this.level) {
      if (data) {
        console.log(logMessage, data);
      } else {
        console.log(logMessage);
      }
    }
  }

  debug(message, data) {
    this._log('debug', message, data);
  }

  info(message, data) {
    this._log('info', message, data);
  }

  warn(message, data) {
    this._log('warn', message, data);
  }

  error(message, data) {
    this._log('error', message, data);
  }

  // 特殊方法
  success(message) {
    this.info(`✅ ${message}`);
  }

  task(message) {
    this.info(`📝 ${message}`);
  }

  waiting(message) {
    this.info(`⏳ ${message}`);
  }
}

module.exports = Logger;
