const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const chalk = require('chalk');

class BotManager {
    constructor() {
        this.botProcess = null;
        this.isRestarting = false;
        this.restartCount = 0;
        this.maxRestarts = 10;
        this.consecutiveFailures = 0;
        this.lastFailureTime = null;
        this.backoffTime = 1000;
        this.maxBackoffTime = 30000;
        this.errorHistory = [];
        this.shutdownInProgress = false;
        this.forceKillTimeout = null;
        this.moduleWatcher = null;
        
        this.dataDir = path.join(__dirname, 'data');
        this.logsDir = path.join(__dirname, 'logs');
        this.sessionDir = path.join(__dirname, 'session');
        this.modulesDir = path.join(__dirname, 'modules');
        
        this.symbols = {
            bullet: '◦',
            arrow: '▸',
            check: '✓',
            cross: '✗',
            warning: '⚠',
            info: 'ℹ',
            success: '✅',
            error: '❌',
            status: '◉',
            system: '⬢',
            network: '◯'
        };
        
        this.init();
    }

    init() {
        this.setupDirectories();
        this.setupSignalHandlers();
        this.setupErrorHandling();
        this.setupFileWatcher();
        this.cleanupOrphanedProcesses();
    }

    setupDirectories() {
        const dirs = [this.dataDir, this.logsDir, this.sessionDir, this.modulesDir];
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
        
        const rawDir = path.join(this.dataDir, 'raw');
        if (!fs.existsSync(rawDir)) {
            fs.mkdirSync(rawDir, { recursive: true });
        }
    }

    log(message, type = 'INFO') {
        const timestamp = new Date().toLocaleTimeString();
        const symbol = type === 'ERROR' ? this.symbols.error : 
                      type === 'WARNING' ? this.symbols.warning :
                      type === 'SUCCESS' ? this.symbols.success :
                      this.symbols.system;
        
        const color = type === 'ERROR' ? chalk.red :
                     type === 'WARNING' ? chalk.yellow :
                     type === 'SUCCESS' ? chalk.green :
                     chalk.cyan;

        console.log(color(`[${timestamp}] ${symbol} [MANAGER] ${message}`));
        
        try {
            const logEntry = {
                timestamp: new Date().toISOString(),
                type,
                message,
                component: 'MANAGER'
            };
            const logFile = path.join(this.logsDir, 'manager.log');
            fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
        } catch (error) {}
    }

    recordError(error) {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            error: error.toString(),
            stack: error.stack
        };
        
        this.errorHistory.unshift(errorEntry);
        if (this.errorHistory.length > 20) {
            this.errorHistory = this.errorHistory.slice(0, 20);
        }

        try {
            const errorLogPath = path.join(this.logsDir, 'manager_errors.json');
            fs.writeFileSync(errorLogPath, JSON.stringify(this.errorHistory, null, 2));
        } catch (writeError) {
            this.log(`Failed to write error log: ${writeError.message}`, 'ERROR');
        }
    }

    calculateBackoff() {
        const now = Date.now();
        if (this.lastFailureTime && (now - this.lastFailureTime) < 30000) {
            this.consecutiveFailures++;
            this.backoffTime = Math.min(this.backoffTime * 1.5, this.maxBackoffTime);
        } else {
            this.consecutiveFailures = 1;
            this.backoffTime = 1000;
        }
        this.lastFailureTime = now;
        return this.backoffTime;
    }

    resetFailureCount() {
        this.consecutiveFailures = 0;
        this.backoffTime = 1000;
        this.lastFailureTime = null;
    }

    cleanupOrphanedProcesses() {
        try {
            if (process.platform !== 'win32') {
                const { execSync } = require('child_process');
                
                try {
                    const lockFile = path.join(this.sessionDir, 'session-WhatsApp-bot', 'SingletonLock');
                    if (fs.existsSync(lockFile)) {
                        fs.unlinkSync(lockFile);
                        this.log('Removed session lock file', 'INFO');
                    }
                } catch (e) {}
                
                try {
                    execSync('pkill -f "chromium.*whatsapp" 2>/dev/null || true', { stdio: 'ignore' });
                    execSync('pkill -f "chrome.*whatsapp" 2>/dev/null || true', { stdio: 'ignore' });
                } catch (e) {}
            }
        } catch (error) {
            this.log(`Process cleanup warning: ${error.message}`, 'WARNING');
        }
    }

    start() {
        if (this.isRestarting || this.shutdownInProgress) return;
        
        this.cleanupOrphanedProcesses();
        this.log(`Starting bot process (Attempt ${this.restartCount + 1})`);
        
        try {
            this.botProcess = spawn('node', ['bot.js'], {
                stdio: 'inherit',
                cwd: __dirname,
                env: { 
                    ...process.env, 
                    NODE_ENV: 'production',
                    FORCE_COLOR: '1'
                },
                detached: false
            });

            this.botProcess.on('spawn', () => {
                this.log('Bot process spawned successfully', 'SUCCESS');
                this.resetFailureCount();
            });

            this.botProcess.on('exit', (code, signal) => {
                if (this.shutdownInProgress) return;
                
                this.log(`Bot process exited (code: ${code}, signal: ${signal})`);
                
                if (this.forceKillTimeout) {
                    clearTimeout(this.forceKillTimeout);
                    this.forceKillTimeout = null;
                }
                
                if (code === 99) {
                    this.log('Bot requested restart', 'INFO');
                    setTimeout(() => this.restart(), 1000);
                } else if (code === 0) {
                    this.log('Bot shutdown normally', 'SUCCESS');
                    this.gracefulExit(0);
                } else if (code === 2) {
                    this.log('Bot force exit', 'WARNING');
                    this.gracefulExit(2);
                } else if (!this.isRestarting) {
                    this.handleUnexpectedExit(code, signal);
                }
            });

            this.botProcess.on('error', (error) => {
                if (this.shutdownInProgress) return;
                
                this.log(`Failed to start bot process: ${error.message}`, 'ERROR');
                this.recordError(error);
                
                if (this.restartCount < this.maxRestarts) {
                    const backoff = this.calculateBackoff();
                    this.log(`Retrying in ${backoff}ms`, 'WARNING');
                    setTimeout(() => this.restart(), backoff);
                } else {
                    this.log(`Max restarts (${this.maxRestarts}) reached`, 'ERROR');
                    this.gracefulExit(1);
                }
            });

        } catch (error) {
            this.log(`Exception while starting bot: ${error.message}`, 'ERROR');
            this.recordError(error);
            
            if (this.restartCount < this.maxRestarts) {
                const backoff = this.calculateBackoff();
                setTimeout(() => this.restart(), backoff);
            } else {
                this.gracefulExit(1);
            }
        }
    }

    handleUnexpectedExit(code, signal) {
        if (this.restartCount < this.maxRestarts) {
            const backoff = this.calculateBackoff();
            this.log(`Auto-restarting (${this.restartCount + 1}/${this.maxRestarts}) in ${(backoff/1000).toFixed(1)}s`, 'WARNING');
            
            if (this.consecutiveFailures > 3) {
                this.log(`Multiple failures detected (${this.consecutiveFailures})`, 'WARNING');
            }
            
            setTimeout(() => this.restart(), backoff);
        } else {
            this.log(`Max restarts reached. Exiting.`, 'ERROR');
            this.gracefulExit(1);
        }
    }

    restart() {
        if (this.isRestarting || this.shutdownInProgress) return;
        
        this.isRestarting = true;
        this.restartCount++;
        
        this.log(`Restarting bot (Restart #${this.restartCount})`);
        
        if (this.botProcess && !this.botProcess.killed) {
            this.botProcess.kill('SIGTERM');
            
            this.forceKillTimeout = setTimeout(() => {
                if (this.botProcess && !this.botProcess.killed) {
                    this.log('Force killing bot process', 'WARNING');
                    this.botProcess.kill('SIGKILL');
                }
            }, 3000);
        }
        
        setTimeout(() => {
            this.isRestarting = false;
            this.start();
        }, 1500);
    }

    setupFileWatcher() {
        try {
            const mainWatcher = chokidar.watch(['bot.js'], {
                ignored: /node_modules/,
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 1000,
                    pollInterval: 100
                }
            });

            mainWatcher.on('change', (filepath) => {
                this.log(`Core file changed: ${path.basename(filepath)}`, 'INFO');
                this.log('Restarting bot due to core file change...', 'INFO');
                setTimeout(() => this.restart(), 500);
            });

            mainWatcher.on('error', (error) => {
                this.log(`Main watcher error: ${error.message}`, 'ERROR');
            });

            if (fs.existsSync(this.modulesDir)) {
                this.moduleWatcher = chokidar.watch(path.join(this.modulesDir, '**/*.js'), {
                    ignored: /node_modules/,
                    persistent: true,
                    ignoreInitial: true,
                    awaitWriteFinish: {
                        stabilityThreshold: 1000,
                        pollInterval: 100
                    }
                });

                this.moduleWatcher.on('change', (filepath) => {
                    this.log(`Module changed: ${path.basename(filepath)}`, 'INFO');
                    this.sendSignalToBot('SIGHUP');
                });

                this.moduleWatcher.on('add', (filepath) => {
                    this.log(`New module: ${path.basename(filepath)}`, 'INFO');
                    this.sendSignalToBot('SIGHUP');
                });

                this.moduleWatcher.on('unlink', (filepath) => {
                    this.log(`Module removed: ${path.basename(filepath)}`, 'INFO');
                    this.sendSignalToBot('SIGHUP');
                });

                this.moduleWatcher.on('error', (error) => {
                    this.log(`Module watcher error: ${error.message}`, 'ERROR');
                });
            }

        } catch (error) {
            this.log(`Failed to setup file watcher: ${error.message}`, 'WARNING');
        }
    }

    sendSignalToBot(signal) {
        if (this.botProcess && !this.botProcess.killed && this.botProcess.pid) {
            try {
                process.kill(this.botProcess.pid, signal);
                this.log(`Sent ${signal} to bot process`, 'INFO');
            } catch (error) {
                this.log(`Failed to send ${signal}: ${error.message}`, 'ERROR');
            }
        }
    }

    setupSignalHandlers() {
        const gracefulShutdown = (signal) => {
            if (this.shutdownInProgress) return;
            this.shutdownInProgress = true;
            
            this.log(`Received ${signal}, shutting down...`);
            
            if (this.botProcess && !this.botProcess.killed) {
                this.botProcess.kill('SIGTERM');
                
                setTimeout(() => {
                    if (this.botProcess && !this.botProcess.killed) {
                        this.log('Force terminating bot', 'WARNING');
                        this.botProcess.kill('SIGKILL');
                    }
                    this.gracefulExit(0);
                }, 3000);
            } else {
                this.gracefulExit(0);
            }
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        
        process.on('SIGHUP', () => {
            if (!this.shutdownInProgress) {
                this.log('Received SIGHUP, restarting...', 'INFO');
                this.restart();
            }
        });
    }

    setupErrorHandling() {
        process.on('uncaughtException', (error) => {
            if (error.message.includes('Target closed') || error.message.includes('Session closed') || error.message.includes('Protocol error')) {
                this.log('Browser session closed (normal during shutdown)', 'INFO');
                return;
            }
            
            this.log(`Uncaught Exception: ${error.message}`, 'ERROR');
            this.recordError(error);
            
            if (this.botProcess && !this.botProcess.killed) {
                this.botProcess.kill('SIGKILL');
            }
            
            this.gracefulExit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            if (reason && (reason.toString().includes('Target closed') || reason.toString().includes('Session closed') || reason.toString().includes('Protocol error'))) {
                this.log('Browser target closed (normal during shutdown)', 'INFO');
                return;
            }
            
            this.log(`Unhandled Promise Rejection: ${reason}`, 'WARNING');
            this.recordError(new Error(`Unhandled Promise Rejection: ${reason}`));
        });

        process.on('warning', (warning) => {
            if (!warning.message.includes('MaxListenersExceededWarning')) {
                this.log(`Node.js Warning: ${warning.message}`, 'WARNING');
            }
        });
    }

    gracefulExit(code) {
        this.shutdownInProgress = true;
        this.cleanupOrphanedProcesses();
        
        if (this.forceKillTimeout) {
            clearTimeout(this.forceKillTimeout);
        }

        if (this.moduleWatcher) {
            this.moduleWatcher.close();
        }
        
        this.log(`Manager exiting with code ${code}`, 'INFO');
        process.exit(code);
    }

    showStatus() {
        console.log(chalk.cyan(`${this.symbols.system} WhatsApp Bot Manager v3.1`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.cyan(`${this.symbols.status} Process ID: ${process.pid}`));
        console.log(chalk.cyan(`${this.symbols.status} Restart Count: ${this.restartCount}`));
        console.log(chalk.cyan(`${this.symbols.status} Consecutive Failures: ${this.consecutiveFailures}`));
        console.log(chalk.cyan(`${this.symbols.status} Bot PID: ${this.botProcess?.pid || 'N/A'}`));
        console.log(chalk.cyan(`${this.symbols.status} Error History: ${this.errorHistory.length}`));
        console.log(chalk.cyan(`${this.symbols.status} Module Watcher: ${this.moduleWatcher ? 'Active' : 'Inactive'}`));
        console.log(chalk.gray('─'.repeat(40)));
    }
}

if (require.main === module) {
    console.clear();
    console.log(chalk.cyan(`◈ WhatsApp Bot Manager v3.1 Stable`));
    console.log(chalk.gray('─'.repeat(50)));
    
    const manager = new BotManager();
    manager.start();
    
    setTimeout(() => {
        if (!manager.shutdownInProgress) {
            manager.showStatus();
        }
    }, 2000);
}

module.exports = BotManager;