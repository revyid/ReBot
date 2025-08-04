const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const chalk = require('chalk');
const https = require('https');

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
        this.updateCheckInterval = null;
        
        this.dataDir = path.join(__dirname, 'data');
        this.logsDir = path.join(__dirname, 'logs');
        this.sessionDir = path.join(__dirname, 'session');
        this.modulesDir = path.join(__dirname, 'modules');
        this.configPath = path.join(__dirname, 'config.json');
        
        // GitHub configuration
        this.repoUrl = 'https://github.com/revyid/ReBot.git';
        this.repoOwner = 'revyid';
        this.repoName = 'ReBot';
        this.currentCommitHash = null;
        this.lastUpdateCheck = null;
        
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
            network: '◯',
            update: '🔄',
            download: '⬇️'
        };
        
        this.config = this.loadConfig();
        this.init();
    }

    loadConfig() {
        const defaultConfig = {
            autoUpdate: true,
            updateCheckInterval: 30, // minutes
            updateOnStart: true,
            backupBeforeUpdate: true,
            restartAfterUpdate: true,
            allowPrerelease: false,
            updateBranch: 'main'
        };

        try {
            if (fs.existsSync(this.configPath)) {
                const existingConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                
                // Check if auto-update config is missing and add it
                let configUpdated = false;
                const mergedConfig = { ...defaultConfig, ...existingConfig };
                
                // Check for missing auto-update keys
                Object.keys(defaultConfig).forEach(key => {
                    if (!(key in existingConfig)) {
                        this.log(`Adding missing config: ${key} = ${defaultConfig[key]}`, 'INFO');
                        configUpdated = true;
                    }
                });
                
                // Update config file if new keys were added
                if (configUpdated) {
                    fs.writeFileSync(this.configPath, JSON.stringify(mergedConfig, null, 2));
                    this.log('Updated config.json with auto-update settings', 'SUCCESS');
                }
                
                return mergedConfig;
            } else {
                fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
                this.log('Created default config.json with auto-update settings', 'SUCCESS');
                return defaultConfig;
            }
        } catch (error) {
            this.log(`Failed to load config: ${error.message}`, 'ERROR');
            return defaultConfig;
        }
    }

    updateConfigWithAutoUpdate() {
        try {
            if (fs.existsSync(this.configPath)) {
                const existingConfig = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                
                const autoUpdateDefaults = {
                    autoUpdate: true,
                    updateCheckInterval: 30,
                    updateOnStart: true,
                    backupBeforeUpdate: true,
                    restartAfterUpdate: true,
                    allowPrerelease: false,
                    updateBranch: 'main'
                };
                
                let configUpdated = false;
                
                // Add missing auto-update keys
                Object.keys(autoUpdateDefaults).forEach(key => {
                    if (!(key in existingConfig)) {
                        existingConfig[key] = autoUpdateDefaults[key];
                        configUpdated = true;
                        this.log(`Added missing config: ${key} = ${autoUpdateDefaults[key]}`, 'INFO');
                    }
                });
                
                if (configUpdated) {
                    fs.writeFileSync(this.configPath, JSON.stringify(existingConfig, null, 2));
                    this.log('Successfully updated config.json with auto-update settings', 'SUCCESS');
                    this.config = existingConfig;
                    return true;
                } else {
                    this.log('Config already contains all auto-update settings', 'INFO');
                    return false;
                }
            } else {
                this.log('Config file not found, will be created automatically', 'INFO');
                return false;
            }
        } catch (error) {
            this.log(`Failed to update config: ${error.message}`, 'ERROR');
            return false;
        }
    }

    saveConfig() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (error) {
            this.log(`Failed to save config: ${error.message}`, 'ERROR');
        }
    }

    init() {
        this.setupDirectories();
        this.setupSignalHandlers();
        this.setupErrorHandling();
        this.setupFileWatcher();
        this.cleanupOrphanedProcesses();
        this.getCurrentCommitHash();
        
        if (this.config.updateOnStart) {
            setTimeout(() => this.checkForUpdates(), 5000);
        }
        
        if (this.config.autoUpdate && this.config.updateCheckInterval > 0) {
            this.setupUpdateChecker();
        }
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

        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
    }

    getCurrentCommitHash() {
        try {
            this.currentCommitHash = execSync('git rev-parse HEAD', { 
                cwd: __dirname,
                encoding: 'utf8'
            }).trim();
            this.log(`Current commit: ${this.currentCommitHash.substring(0, 7)}`, 'INFO');
        } catch (error) {
            this.log(`Failed to get current commit hash: ${error.message}`, 'WARNING');
        }
    }

    setupUpdateChecker() {
        const intervalMs = this.config.updateCheckInterval * 60 * 1000;
        this.updateCheckInterval = setInterval(() => {
            this.checkForUpdates();
        }, intervalMs);
        
        this.log(`Update checker enabled (${this.config.updateCheckInterval}m interval)`, 'INFO');
    }

    async checkForUpdates() {
        if (!this.config.autoUpdate) {
            this.log('Auto-update is disabled', 'INFO');
            return;
        }

        this.log(`${this.symbols.update} Checking for updates...`, 'INFO');
        this.lastUpdateCheck = new Date();

        try {
            const latestCommit = await this.getLatestCommitFromGitHub();
            
            if (!latestCommit) {
                this.log('Failed to fetch latest commit info', 'WARNING');
                return;
            }

            if (this.currentCommitHash && latestCommit.sha === this.currentCommitHash) {
                this.log('Already up to date', 'SUCCESS');
                return;
            }

            this.log(`${this.symbols.download} New update available!`, 'SUCCESS');
            this.log(`Current: ${this.currentCommitHash ? this.currentCommitHash.substring(0, 7) : 'unknown'}`, 'INFO');
            this.log(`Latest:  ${latestCommit.sha.substring(0, 7)}`, 'INFO');
            this.log(`Message: ${latestCommit.commit.message}`, 'INFO');
            
            if (this.config.backupBeforeUpdate) {
                await this.createBackup();
            }
            
            await this.performUpdate();
            
        } catch (error) {
            this.log(`Update check failed: ${error.message}`, 'ERROR');
            this.recordError(error);
        }
    }

    getLatestCommitFromGitHub() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${this.repoOwner}/${this.repoName}/commits/${this.config.updateBranch}`,
                method: 'GET',
                headers: {
                    'User-Agent': 'ReBot-Manager/1.0',
                    'Accept': 'application/vnd.github.v3+json'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        if (res.statusCode === 200) {
                            const commit = JSON.parse(data);
                            resolve(commit);
                        } else if (res.statusCode === 403) {
                            this.log('GitHub API rate limit exceeded', 'WARNING');
                            resolve(null);
                        } else {
                            this.log(`GitHub API returned ${res.statusCode}`, 'WARNING');
                            resolve(null);
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    async createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(__dirname, 'backups', `backup-${timestamp}`);
            
            this.log(`${this.symbols.info} Creating backup...`, 'INFO');
            
            // Create backup directory
            fs.mkdirSync(backupDir, { recursive: true });
            
            // Copy important files (excluding node_modules, logs, session, etc.)
            const filesToBackup = [
                'bot.js',
                'package.json',
                'config.json',
                'modules',
                'data'
            ];
            
            for (const item of filesToBackup) {
                const srcPath = path.join(__dirname, item);
                const destPath = path.join(backupDir, item);
                
                if (fs.existsSync(srcPath)) {
                    if (fs.statSync(srcPath).isDirectory()) {
                        execSync(`cp -r "${srcPath}" "${destPath}"`, { stdio: 'ignore' });
                    } else {
                        execSync(`cp "${srcPath}" "${destPath}"`, { stdio: 'ignore' });
                    }
                }
            }
            
            this.log(`Backup created: ${path.basename(backupDir)}`, 'SUCCESS');
            
            // Keep only last 5 backups
            this.cleanupOldBackups();
            
        } catch (error) {
            this.log(`Backup failed: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    cleanupOldBackups() {
        try {
            const backupDir = path.join(__dirname, 'backups');
            const backups = fs.readdirSync(backupDir)
                .filter(name => name.startsWith('backup-'))
                .map(name => ({
                    name,
                    path: path.join(backupDir, name),
                    mtime: fs.statSync(path.join(backupDir, name)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime);
            
            // Keep only the 5 most recent backups
            if (backups.length > 5) {
                for (let i = 5; i < backups.length; i++) {
                    execSync(`rm -rf "${backups[i].path}"`, { stdio: 'ignore' });
                    this.log(`Removed old backup: ${backups[i].name}`, 'INFO');
                }
            }
        } catch (error) {
            this.log(`Backup cleanup failed: ${error.message}`, 'WARNING');
        }
    }

    async performUpdate() {
        try {
            this.log(`${this.symbols.download} Starting update process...`, 'INFO');
            
            // Stop bot if running
            const wasRunning = this.botProcess && !this.botProcess.killed;
            if (wasRunning) {
                this.log('Stopping bot for update...', 'INFO');
                this.botProcess.kill('SIGTERM');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            // Perform git pull
            this.log('Pulling latest changes...', 'INFO');
            execSync('git fetch origin', { cwd: __dirname, stdio: 'inherit' });
            execSync(`git reset --hard origin/${this.config.updateBranch}`, { cwd: __dirname, stdio: 'inherit' });
            
            // Update npm packages
            this.log('Updating dependencies...', 'INFO');
            execSync('npm install --production', { cwd: __dirname, stdio: 'inherit' });
            
            // Update current commit hash
            this.getCurrentCommitHash();
            
            this.log(`${this.symbols.success} Update completed successfully!`, 'SUCCESS');
            
            // Restart bot if it was running
            if (wasRunning && this.config.restartAfterUpdate) {
                this.log('Restarting bot...', 'INFO');
                setTimeout(() => this.start(), 2000);
            }
            
        } catch (error) {
            this.log(`Update failed: ${error.message}`, 'ERROR');
            this.recordError(error);
            
            // Try to restore from backup if available
            await this.restoreFromBackup();
            throw error;
        }
    }

    async restoreFromBackup() {
        try {
            const backupDir = path.join(__dirname, 'backups');
            const backups = fs.readdirSync(backupDir)
                .filter(name => name.startsWith('backup-'))
                .map(name => ({
                    name,
                    path: path.join(backupDir, name),
                    mtime: fs.statSync(path.join(backupDir, name)).mtime
                }))
                .sort((a, b) => b.mtime - a.mtime);
            
            if (backups.length === 0) {
                this.log('No backup available for restore', 'WARNING');
                return;
            }
            
            const latestBackup = backups[0];
            this.log(`Restoring from backup: ${latestBackup.name}`, 'WARNING');
            
            // Restore files
            execSync(`cp -r "${latestBackup.path}"/* "${__dirname}"/`, { stdio: 'inherit' });
            
            this.log('Backup restored successfully', 'SUCCESS');
            this.getCurrentCommitHash();
            
        } catch (error) {
            this.log(`Backup restore failed: ${error.message}`, 'ERROR');
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

        // Handle update signal
        process.on('SIGUSR1', () => {
            if (!this.shutdownInProgress) {
                this.log('Received SIGUSR1, checking for updates...', 'INFO');
                this.checkForUpdates();
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

        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
        }

        if (this.moduleWatcher) {
            this.moduleWatcher.close();
        }
        
        this.log(`Manager exiting with code ${code}`, 'INFO');
        process.exit(code);
    }

    showStatus() {
        console.log(chalk.cyan(`${this.symbols.system} WhatsApp Bot Manager v3.2 (with Auto-Update)`));
        console.log(chalk.gray('─'.repeat(50)));
        console.log(chalk.cyan(`${this.symbols.status} Process ID: ${process.pid}`));
        console.log(chalk.cyan(`${this.symbols.status} Restart Count: ${this.restartCount}`));
        console.log(chalk.cyan(`${this.symbols.status} Consecutive Failures: ${this.consecutiveFailures}`));
        console.log(chalk.cyan(`${this.symbols.status} Bot PID: ${this.botProcess?.pid || 'N/A'}`));
        console.log(chalk.cyan(`${this.symbols.status} Error History: ${this.errorHistory.length}`));
        console.log(chalk.cyan(`${this.symbols.status} Module Watcher: ${this.moduleWatcher ? 'Active' : 'Inactive'}`));
        console.log(chalk.cyan(`${this.symbols.status} Auto Update: ${this.config.autoUpdate ? 'Enabled' : 'Disabled'}`));
        console.log(chalk.cyan(`${this.symbols.status} Update Interval: ${this.config.updateCheckInterval}m`));
        console.log(chalk.cyan(`${this.symbols.status} Current Commit: ${this.currentCommitHash ? this.currentCommitHash.substring(0, 7) : 'unknown'}`));
        console.log(chalk.cyan(`${this.symbols.status} Last Update Check: ${this.lastUpdateCheck ? this.lastUpdateCheck.toLocaleTimeString() : 'Never'}`));
        console.log(chalk.gray('─'.repeat(50)));
        
        if (this.config.autoUpdate) {
            console.log(chalk.green(`${this.symbols.info} Auto-update is enabled`));
            console.log(chalk.green(`${this.symbols.info} Repository: ${this.repoUrl}`));
            console.log(chalk.green(`${this.symbols.info} Branch: ${this.config.updateBranch}`));
        } else {
            console.log(chalk.yellow(`${this.symbols.warning} Auto-update is disabled`));
        }
        console.log(chalk.gray('─'.repeat(50)));
    }

    // Manual update trigger
    async triggerUpdate() {
        this.log('Manual update triggered', 'INFO');
        await this.checkForUpdates();
    }

    // Toggle auto-update
    toggleAutoUpdate() {
        this.config.autoUpdate = !this.config.autoUpdate;
        this.saveConfig();
        
        if (this.config.autoUpdate) {
            this.log('Auto-update enabled', 'SUCCESS');
            if (!this.updateCheckInterval) {
                this.setupUpdateChecker();
            }
        } else {
            this.log('Auto-update disabled', 'WARNING');
            if (this.updateCheckInterval) {
                clearInterval(this.updateCheckInterval);
                this.updateCheckInterval = null;
            }
        }
    }

    // Set update interval
    setUpdateInterval(minutes) {
        if (minutes < 1) {
            this.log('Update interval must be at least 1 minute', 'ERROR');
            return;
        }
        
        this.config.updateCheckInterval = minutes;
        this.saveConfig();
        
        if (this.updateCheckInterval) {
            clearInterval(this.updateCheckInterval);
        }
        
        if (this.config.autoUpdate) {
            this.setupUpdateChecker();
        }
        
        this.log(`Update interval set to ${minutes} minutes`, 'SUCCESS');
    }

    // Get version info
    async getVersionInfo() {
        try {
            const local = {
                commit: this.currentCommitHash,
                shortCommit: this.currentCommitHash ? this.currentCommitHash.substring(0, 7) : 'unknown',
                lastCheck: this.lastUpdateCheck
            };
            
            const remote = await this.getLatestCommitFromGitHub();
            
            return {
                local,
                remote: remote ? {
                    commit: remote.sha,
                    shortCommit: remote.sha.substring(0, 7),
                    message: remote.commit.message,
                    author: remote.commit.author.name,
                    date: remote.commit.author.date
                } : null,
                updateAvailable: remote && local.commit !== remote.sha
            };
        } catch (error) {
            this.log(`Failed to get version info: ${error.message}`, 'ERROR');
            return null;
        }
    }

    // Show update status
    async showUpdateStatus() {
        const versionInfo = await this.getVersionInfo();
        
        if (!versionInfo) {
            console.log(chalk.red(`${this.symbols.error} Failed to fetch version information`));
            return;
        }
        
        console.log(chalk.cyan(`${this.symbols.update} Update Status`));
        console.log(chalk.gray('─'.repeat(40)));
        
        console.log(chalk.cyan(`${this.symbols.status} Local Version:`));
        console.log(`  Commit: ${versionInfo.local.shortCommit}`);
        console.log(`  Last Check: ${versionInfo.local.lastCheck ? versionInfo.local.lastCheck.toLocaleString() : 'Never'}`);
        
        if (versionInfo.remote) {
            console.log(chalk.cyan(`${this.symbols.network} Remote Version:`));
            console.log(`  Commit: ${versionInfo.remote.shortCommit}`);
            console.log(`  Message: ${versionInfo.remote.message}`);
            console.log(`  Author: ${versionInfo.remote.author}`);
            console.log(`  Date: ${new Date(versionInfo.remote.date).toLocaleString()}`);
            
            if (versionInfo.updateAvailable) {
                console.log(chalk.green(`${this.symbols.success} Update available!`));
            } else {
                console.log(chalk.green(`${this.symbols.check} Up to date`));
            }
        } else {
            console.log(chalk.yellow(`${this.symbols.warning} Could not fetch remote version`));
        }
        
        console.log(chalk.gray('─'.repeat(40)));
    }
}

if (require.main === module) {
    console.clear();
    console.log(chalk.cyan(`◈ WhatsApp Bot Manager v3.2 with Auto-Update`));
    console.log(chalk.gray('─'.repeat(55)));
    
    const manager = new BotManager();
    
    // Handle command line arguments
    const args = process.argv.slice(2);
    
    if (args.includes('--check-update')) {
        manager.showUpdateStatus().then(() => {
            if (!args.includes('--start')) {
                process.exit(0);
            }
        });
    }
    
    if (args.includes('--update')) {
        manager.triggerUpdate().then(() => {
            if (!args.includes('--start')) {
                process.exit(0);
            }
        });
    }
    
    if (args.includes('--toggle-auto-update')) {
        manager.toggleAutoUpdate();
        if (!args.includes('--start')) {
            process.exit(0);
        }
    }
    
    if (args.includes('--update-config')) {
        const updated = manager.updateConfigWithAutoUpdate();
        if (updated) {
            console.log(chalk.green(`${manager.symbols.success} Config updated with auto-update settings`));
        } else {
            console.log(chalk.yellow(`${manager.symbols.info} Config already up to date`));
        }
        if (!args.includes('--start')) {
            process.exit(0);
        }
    }
    
    if (args.includes('--set-interval')) {
        const intervalIndex = args.indexOf('--set-interval');
        const interval = parseInt(args[intervalIndex + 1]);
        if (!isNaN(interval)) {
            manager.setUpdateInterval(interval);
        } else {
            console.log(chalk.red('Invalid interval value'));
        }
        if (!args.includes('--start')) {
            process.exit(0);
        }
    }
    
    if (args.includes('--version') || args.includes('-v')) {
        manager.showUpdateStatus().then(() => {
            process.exit(0);
        });
    }
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(chalk.cyan('WhatsApp Bot Manager v3.2 - Command Line Options:'));
        console.log('');
        console.log(chalk.white('  --start                Start the bot manager'));
        console.log(chalk.white('  --check-update         Check for updates'));
        console.log(chalk.white('  --update               Force update'));
        console.log(chalk.white('  --toggle-auto-update   Toggle auto-update on/off'));
        console.log(chalk.white('  --update-config        Add auto-update settings to existing config'));
        console.log(chalk.white('  --set-interval <min>   Set update check interval in minutes'));
        console.log(chalk.white('  --version, -v          Show version information'));
        console.log(chalk.white('  --help, -h             Show this help'));
        console.log('');
        console.log(chalk.gray('Examples:'));
        console.log(chalk.gray('  node main.js --start'));
        console.log(chalk.gray('  node main.js --check-update'));
        console.log(chalk.gray('  node main.js --update --start'));
        console.log(chalk.gray('  node main.js --update-config'));
        console.log(chalk.gray('  node main.js --set-interval 15 --start'));
        process.exit(0);
    }
    
    // Start the manager (default behavior or with --start flag)
    if (args.length === 0 || args.includes('--start')) {
        manager.start();
        
        setTimeout(() => {
            if (!manager.shutdownInProgress) {
                manager.showStatus();
            }
        }, 3000);
    }
}

module.exports = BotManager;