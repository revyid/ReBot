const { Client, LocalAuth, NoAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chokidar = require('chokidar');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

class WABot {
    constructor() {
        this.startTime = Date.now();
        this.users = new Map();
        this.admins = new Set();
        this.messageCount = 0;
        this.sessionId = this.generateSessionId();
        this.logFile = path.join(__dirname, 'logs', `session_${this.sessionId}.log`);
        this.terminalMode = 'normal';
        this.pendingAdminAdd = null;
        this.pendingAdminRemove = null;
        this.watcher = null;
        this.isReloading = false;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.rateLimits = new Map();
        this.cooldowns = new Map();
        this.scheduledMessages = new Map();
        this.dataDir = path.join(__dirname, 'data');
        this.adminsFile = path.join(this.dataDir, 'admins.txt');
        this.usersFile = path.join(this.dataDir, 'users.txt');
        this.scheduledMessagesFile = path.join(this.dataDir, 'scheduled.txt');
        this.loginMethod = 'qr';
        this.phoneNumber = null;
        this.pairingCode = null;
        this.isAuthenticated = false;
        this.restartInProgress = false;
        this.modules = new Map();
        this.setupDataDir();
        this.loadPersistentData();
        this.setupLogger();
        this.createClient();
        this.setupEventHandlers();
        this.loadModules();
        this.setupWatcher();
        this.setupTerminalCommands();
        this.setupProgressAnimation();
        this.setupRateLimit();
        this.setupMessageScheduler();
        this.setupTypingSimulation();
    }

    generateSessionId() {
        const now = new Date();
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    }

    createClient() {
        const authStrategy = this.loginMethod === 'phone' ? new NoAuth() : new LocalAuth({ 
            clientId: 'WhatsApp-bot', 
            dataPath: './session' 
        });

        this.client = new Client({
            authStrategy: authStrategy,
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor'
                ],
                executablePath: this.getChromePath()
            },
            userAgent: this.getSystemUserAgent(),
            restartOnAuthFail: true,
            qrMaxRetries: 5,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0
        });
    }

    setupDataDir() {
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    }

    loadPersistentData() {
        try {
            if (fs.existsSync(this.adminsFile)) {
                fs.readFileSync(this.adminsFile, 'utf8').trim().split('\n').filter(line => line.trim()).forEach(number => this.admins.add(number.trim()));
            }
            if (fs.existsSync(this.usersFile)) {
                fs.readFileSync(this.usersFile, 'utf8').trim().split('\n').filter(line => line.trim()).forEach(line => {
                    const [id, name, messageCount, isAdmin, firstSeen] = line.split('|');
                    this.users.set(id, { id, name, messageCount: parseInt(messageCount) || 0, isAdmin: isAdmin === 'true', firstSeen: new Date(firstSeen || Date.now()) });
                });
            }
            if (fs.existsSync(this.scheduledMessagesFile)) {
                fs.readFileSync(this.scheduledMessagesFile, 'utf8').trim().split('\n').filter(line => line.trim()).forEach(line => {
                    const [id, recipient, message, timestamp] = line.split('|');
                    this.scheduledMessages.set(id, { recipient, message, timestamp: new Date(parseInt(timestamp)) });
                });
            }
        } catch (error) {}
    }

    saveAdmins() {
        try {
            fs.writeFileSync(this.adminsFile, Array.from(this.admins).join('\n'));
        } catch (error) {}
    }

    saveUsers() {
        try {
            fs.writeFileSync(this.usersFile, Array.from(this.users.values())
                .map(user => `${user.id}|${user.name}|${user.messageCount}|${user.isAdmin}|${user.firstSeen.toISOString()}`)
                .join('\n'));
        } catch (error) {}
    }

    saveScheduledMessages() {
        try {
            fs.writeFileSync(this.scheduledMessagesFile, Array.from(this.scheduledMessages.entries())
                .map(([id, { recipient, message, timestamp }]) => `${id}|${recipient}|${message}|${timestamp.getTime()}`)
                .join('\n'));
        } catch (error) {}
    }

    setupLogger() {
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    }

    log(message, type = 'INFO') {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(this.logFile, `[${timestamp}] [${type}] ${message}\n`);
    }

    getChromePath() {
        const paths = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            process.env.CHROME_BIN,
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/opt/google/chrome/chrome',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ];
        for (const chromePath of paths) {
            if (chromePath && fs.existsSync(chromePath)) {
                this.log(`Using Chrome: ${chromePath}`);
                return chromePath;
            }
        }
        this.log('Chrome not found, using default');
        return undefined;
    }

    getSystemUserAgent() {
        const platform = os.platform();
        const arch = os.arch();
        const release = os.release();
        
        let platformString = '';
        let osString = '';
        
        if (platform === 'win32') {
            platformString = 'Windows NT 10.0; Win64; x64';
            osString = 'Windows';
        } else if (platform === 'darwin') {
            const macVersion = release.split('.')[0];
            const macVersionMap = {
                '23': '14_0',
                '22': '13_0', 
                '21': '12_0',
                '20': '11_0',
                '19': '10_15',
                '18': '10_14'
            };
            const mappedVersion = macVersionMap[macVersion] || '10_15';
            platformString = `Macintosh; Intel Mac OS X ${mappedVersion.replace('_', '_')}`;
            osString = 'macOS';
        } else if (platform === 'linux') {
            platformString = arch === 'x64' ? 'X11; Linux x86_64' : 'X11; Linux i686';
            osString = 'Linux';
            
            try {
                if (fs.existsSync('/etc/os-release')) {
                    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
                    const nameMatch = osRelease.match(/^NAME="?([^"\n]+)"?/m);
                    if (nameMatch) {
                        osString = nameMatch[1];
                    }
                }
            } catch (error) {}
        }
        
        const userAgent = `Mozilla/5.0 (${platformString}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`;
        this.log(`System detected: ${osString} | User Agent: ${userAgent}`);
        return userAgent;
    }

    setupProgressAnimation() {
        const frames = ['⣾', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽'];
        let i = 0;
        this.progressInterval = setInterval(() => {
            if (!this.isAuthenticated) {
                process.stdout.write(`\r${chalk.cyan(frames[i++ % frames.length])} Initializing...`);
            }
        }, 120);
    }

    getSystemInfo() {
        const platform = os.platform();
        const arch = os.arch();
        const release = os.release();
        const hostname = os.hostname();
        const cpus = os.cpus();
        const totalmem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        const freemem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
        let distro = 'Unknown';
        try {
            if (platform === 'linux') {
                if (fs.existsSync('/etc/os-release')) {
                    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
                    const prettyName = osRelease.match(/PRETTY_NAME="([^"]+)"/);
                    if (prettyName) distro = prettyName[1];
                }
            } else if (platform === 'darwin') {
                distro = `macOS ${release}`;
            } else if (platform === 'win32') {
                distro = `Windows ${release}`;
            }
        } catch (error) {
            distro = `${platform} ${release}`;
        }
        return { platform, arch, release, hostname, distro, cpu: cpus[0]?.model || 'Unknown', cpuCores: cpus.length, totalMemory: totalmem, freeMemory: freemem };
    }

    setupRateLimit() {
        this.rateLimitWindow = 60 * 1000;
        this.rateLimitMax = 10;
        this.cooldownPeriod = 5 * 60 * 1000;
        this.messageDelay = 1000;
    }

    setupMessageScheduler() {
        setInterval(async () => {
            const now = Date.now();
            for (const [id, { recipient, message, timestamp }] of this.scheduledMessages) {
                if (timestamp.getTime() <= now) {
                    try {
                        await this.client.sendMessage(recipient, message);
                        this.scheduledMessages.delete(id);
                        this.saveScheduledMessages();
                        this.log(`Scheduled message sent to ${recipient}`);
                    } catch (error) {
                        this.log(`Error sending scheduled message to ${recipient}: ${error.message}`, 'ERROR');
                    }
                }
            }
        }, 60000);
    }

    setupTypingSimulation() {
        this.typingDelayMin = 500;
        this.typingDelayMax = 2000;
    }

    async simulateTyping(chat) {
        await chat.sendStateTyping();
        await new Promise(resolve => setTimeout(resolve, Math.random() * (this.typingDelayMax - this.typingDelayMin) + this.typingDelayMin));
    }

    async checkRateLimit(userId) {
        const now = Date.now();
        if (this.cooldowns.has(userId)) {
            const cooldownEnd = this.cooldowns.get(userId);
            if (now < cooldownEnd) return false;
            this.cooldowns.delete(userId);
        }
        const userLimit = this.rateLimits.get(userId) || { count: 0, start: now };
        if (now - userLimit.start > this.rateLimitWindow) {
            userLimit.count = 0;
            userLimit.start = now;
        }
        userLimit.count++;
        this.rateLimits.set(userId, userLimit);
        if (userLimit.count > this.rateLimitMax) {
            this.cooldowns.set(userId, now + this.cooldownPeriod);
            return false;
        }
        return true;
    }

    async requestPairingCode(phoneNumber) {
        try {
            const code = await this.client.requestPairingCode(phoneNumber);
            return code;
        } catch (error) {
            this.log(`Error requesting pairing code: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    setupEventHandlers() {
        this.client.on('qr', (qr) => {
            if (this.loginMethod === 'qr') {
                clearInterval(this.progressInterval);
                console.clear();
                this.showHeader();
                console.log(chalk.yellow('⬢ Scan QR Code to login'));
                qrcode.generate(qr, { small: true });
                console.log(chalk.gray('Press ENTER to refresh QR or type "phone" to switch to phone login'));
                this.log('QR Code generated');
            }
        });

        this.client.on('authenticated', () => {
            this.isAuthenticated = true;
            this.log('Authentication successful');
        });

        this.client.on('ready', async () => {
            clearInterval(this.progressInterval);
            console.clear();
            this.showHeader();
            const info = this.client.info;
            console.log(chalk.green('⬢ Bot successfully connected'));
            console.log(chalk.cyan(`⬢ Logged in as: ${info.pushname}`));
            console.log(chalk.cyan(`⬢ Number: ${info.wid.user}`));
            console.log(chalk.yellow('⬢ Bot is ready to receive messages'));
            console.log(chalk.gray('Type "h" for terminal help'));
            this.log(`Bot connected as ${info.pushname} (${info.wid.user})`);
            this.admins.add(info.wid.user);
            this.saveAdmins();
            this.startStatusUpdates();
            this.isAuthenticated = true;
        });

        this.client.on('message', async (message) => {
            if (message.type === 'ciphertext' || message.type === 'protocol') return;
            
            this.messageQueue.push(message);
            if (!this.isProcessingQueue) {
                this.startMessageQueue();
            }
        });

        this.client.on('disconnected', (reason) => {
            this.log(`Bot disconnected: ${reason}`, 'ERROR');
            console.log(chalk.red('⚠ Bot disconnected:', reason));
            this.isAuthenticated = false;
            if (!this.restartInProgress) {
                this.restart();
            }
        });

        this.client.on('auth_failure', (msg) => {
            this.log(`Authentication failure: ${msg}`, 'ERROR');
            console.log(chalk.red('⚠ Authentication failure:', msg));
            this.isAuthenticated = false;
            if (!this.restartInProgress) {
                this.restart();
            }
        });
    }

    async startMessageQueue() {
        this.isProcessingQueue = true;
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            try {
                await this.handleMessage(message);
                await new Promise(resolve => setTimeout(resolve, this.messageDelay));
            } catch (error) {
                this.log(`Error processing message: ${error.message}`, 'ERROR');
            }
        }
        this.isProcessingQueue = false;
    }

    startStatusUpdates() {
        setInterval(() => {
            const uptime = Math.floor((Date.now() - this.startTime) / 1000);
            const memory = process.memoryUsage();
            const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
            process.title = `WA Bot | Users: ${this.users.size} | Messages: ${this.messageCount} | RAM: ${memUsed}MB | Uptime: ${uptime}s`;
            this.saveUsers();
            this.saveScheduledMessages();
        }, 30000);
    }

    showHeader() {
        console.log(chalk.red(' ⬤'), chalk.yellow('⬤'), chalk.green('⬤'));
        console.log(chalk.cyan('    ____'));
        console.log(chalk.cyan(`   / __ \\___ _   ____  __`));
        console.log(chalk.cyan(`  / /_/ / _ \\ | / / / / /`));
        console.log(chalk.cyan(` / _, _/  __/ |/ / /_/ /`));
        console.log(chalk.cyan(`/_/ |_|\\___/|___/\\__, /`));
        console.log(chalk.cyan(`                /____/`));
        console.log();
        console.log(chalk.gray(new Date().toString()));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.cyan('⬢ WhatsApp Bot Terminal v4.4'));
        console.log(chalk.gray('─'.repeat(60)));
    }

    async handleMessage(message) {
        this.messageCount++;
        const chat = await message.getChat();
        const contact = await message.getContact();
        const userId = contact.id.user;
        const isCommand = message.body.startsWith('.');

        if (!this.users.has(userId)) {
            this.users.set(userId, {
                id: userId,
                name: contact.pushname || contact.number,
                firstSeen: new Date(),
                messageCount: 0,
                isAdmin: this.admins.has(userId)
            });
            this.log(`New user: ${contact.pushname || contact.number} (${userId})`);
            this.saveUsers();
        }

        const user = this.users.get(userId);
        user.messageCount++;
        user.isAdmin = this.admins.has(userId);

        const timestamp = new Date().toLocaleTimeString();
        console.log(chalk.blue(`[${timestamp}] ${contact.pushname || contact.number}: ${message.body}`));
        this.log(`Message from ${contact.pushname || contact.number}: ${message.body}`);

        if (isCommand) {
            if (!(await this.checkRateLimit(userId))) {
                this.log(`Rate limit exceeded for ${userId}`, 'WARNING');
                return;
            }

            await this.simulateTyping(chat);
            const [command, ...args] = message.body.slice(1).split(' ');
            if (this.modules.has(command)) {
                const module = this.modules.get(command);
                if (module.adminOnly && !user.isAdmin) {
                    await message.reply('⚠ Admin access required');
                    return;
                }
                try {
                    await module.execute(message, args, this.client, this);
                    this.log(`Command executed: ${command} by ${userId}`);
                } catch (error) {
                    console.log(chalk.red(`⚠ Error executing ${command}:`, error.message));
                    this.log(`Error executing ${command}: ${error.message}`, 'ERROR');
                    await message.reply('⚠ An error occurred while processing your command.');
                }
            }
        }

        for (const [name, module] of this.modules) {
            if (module.autoTrigger && module.autoTrigger(message)) {
                await this.simulateTyping(chat);
                try {
                    await module.execute(message, [], this.client, this);
                } catch (error) {
                    this.log(`Error in auto trigger ${name}: ${error.message}`, 'ERROR');
                }
            }
        }
    }

    loadModules() {
        if (this.isReloading) return;
        this.isReloading = true;
        const modulesPath = path.join(__dirname, 'modules');
        if (!fs.existsSync(modulesPath)) fs.mkdirSync(modulesPath, { recursive: true });
        const files = fs.readdirSync(modulesPath).filter(file => file.endsWith('.js'));
        this.modules.clear();
        for (const file of files) {
            try {
                delete require.cache[require.resolve(path.join(modulesPath, file))];
                const module = require(path.join(modulesPath, file));
                this.modules.set(module.name, module);
                console.log(chalk.green(`⬢ Loaded: ${module.name}`));
                this.log(`Module loaded: ${module.name}`);
            } catch (error) {
                console.log(chalk.red(`⚠ Error loading ${file}:`, error.message));
                this.log(`Error loading ${file}: ${error.message}`, 'ERROR');
            }
        }
        setTimeout(() => {
            this.isReloading = false;
        }, 1000);
    }

    setupWatcher() {
        const modulesPath = path.join(__dirname, 'modules');
        if (this.watcher) this.watcher.close();
        this.watcher = chokidar.watch(modulesPath, { ignored: /[\/\\]\./, persistent: true, ignoreInitial: true });
        this.watcher.on('change', () => {
            if (!this.isReloading) {
                console.log(chalk.yellow('⬢ Module changed, reloading...'));
                this.log('Module files changed, reloading');
                this.loadModules();
            }
        });
        this.watcher.on('add', () => {
            if (!this.isReloading) {
                console.log(chalk.green('⬢ New module added'));
                this.loadModules();
            }
        });
        this.watcher.on('unlink', () => {
            if (!this.isReloading) {
                console.log(chalk.red('⬢ Module removed'));
                this.loadModules();
            }
        });
    }

    setupTerminalCommands() {
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: chalk.gray('⬢ ') });
        this.rl.on('line', async (input) => {
            const command = input.trim();
            
            if (this.terminalMode === 'phone_input') {
                const phoneNumber = command.replace(/\D/g, '');
                if (phoneNumber.length >= 10) {
                    try {
                        console.log(chalk.yellow('⬢ Requesting pairing code...'));
                        this.pairingCode = await this.requestPairingCode(phoneNumber);
                        console.log(chalk.green(`⬢ Pairing code: ${this.pairingCode}`));
                        console.log(chalk.cyan('⬢ Enter this code in your WhatsApp app'));
                        this.phoneNumber = phoneNumber;
                        this.terminalMode = 'normal';
                        this.log(`Pairing code requested for ${phoneNumber}: ${this.pairingCode}`);
                    } catch (error) {
                        console.log(chalk.red('⚠ Failed to request pairing code:', error.message));
                        this.terminalMode = 'normal';
                    }
                } else {
                    console.log(chalk.red('⚠ Invalid phone number. Please enter a valid number:'));
                }
                this.rl.prompt();
                return;
            }

            if (this.terminalMode === 'admin_confirm' && this.pendingAdminAdd) {
                if (command.toLowerCase() === 'yes' || command.toLowerCase() === 'y') {
                    this.admins.add(this.pendingAdminAdd);
                    this.saveAdmins();
                    console.log(chalk.green(`⬢ Admin added: ${this.pendingAdminAdd}`));
                    this.log(`Admin added via terminal: ${this.pendingAdminAdd}`);
                } else {
                    console.log(chalk.yellow('⬢ Admin add cancelled'));
                }
                this.terminalMode = 'normal';
                this.pendingAdminAdd = null;
                this.rl.prompt();
                return;
            }
            if (this.terminalMode === 'admin_input') {
                const phoneNumber = command.replace(/\D/g, '');
                if (phoneNumber.length >= 10) {
                    this.pendingAdminAdd = phoneNumber;
                    console.log(chalk.yellow(`⬢ Add ${phoneNumber} as admin? (yes/no):`));
                    this.terminalMode = 'admin_confirm';
                } else {
                    console.log(chalk.red('⚠ Invalid phone number. Please enter a valid number:'));
                }
                this.rl.prompt();
                return;
            }
            if (this.terminalMode === 'admin_remove_confirm' && this.pendingAdminRemove) {
                if (command.toLowerCase() === 'yes' || command.toLowerCase() === 'y') {
                    if (this.pendingAdminRemove === this.client.info?.wid.user) {
                        console.log(chalk.red('⚠ Cannot remove bot owner'));
                    } else {
                        this.admins.delete(this.pendingAdminRemove);
                        this.saveAdmins();
                        if (this.users.has(this.pendingAdminRemove)) {
                            this.users.get(this.pendingAdminRemove).isAdmin = false;
                            this.saveUsers();
                        }
                        console.log(chalk.green(`⬢ Admin removed: ${this.pendingAdminRemove}`));
                        this.log(`Admin removed via terminal: ${this.pendingAdminRemove}`);
                    }
                } else {
                    console.log(chalk.yellow('⬢ Admin remove cancelled'));
                }
                this.terminalMode = 'normal';
                this.pendingAdminRemove = null;
                this.rl.prompt();
                return;
            }
            if (this.terminalMode === 'admin_remove') {
                const phoneNumber = command.replace(/\D/g, '');
                if (this.admins.has(phoneNumber)) {
                    this.pendingAdminRemove = phoneNumber;
                    const user = this.users.get(phoneNumber);
                    const name = user ? user.name : phoneNumber;
                    console.log(chalk.yellow(`⬢ Remove admin ${name} (${phoneNumber})? (yes/no):`));
                    this.terminalMode = 'admin_remove_confirm';
                } else {
                    console.log(chalk.red('⚠ Number not found in admin list'));
                    this.terminalMode = 'normal';
                }
                this.rl.prompt();
                return;
            }
            const cmd = command.toLowerCase();
            switch (cmd) {
                case 'phone':
                    if (!this.isAuthenticated) {
                        this.loginMethod = 'phone';
                        console.log(chalk.yellow('⬢ Phone Login Mode'));
                        console.log(chalk.cyan('Enter phone number (with country code, no +):'));
                        this.terminalMode = 'phone_input';
                    } else {
                        console.log(chalk.red('⚠ Already authenticated'));
                    }
                    break;
                case 'h':
                case 'help':
                    console.log(chalk.yellow('⬢ Terminal Commands:'));
                    console.log(chalk.cyan('  h/help     ⬢ Show this help'));
                    console.log(chalk.cyan('  r/reload   ⬢ Reload modules'));
                    console.log(chalk.cyan('  s/status   ⬢ Show bot status'));
                    console.log(chalk.cyan('  m/modules  ⬢ List loaded modules'));
                    console.log(chalk.cyan('  u/users    ⬢ Show user list'));
                    console.log(chalk.cyan('  a/admins   ⬢ Show admin list'));
                    console.log(chalk.cyan('  l/logs     ⬢ Show recent logs'));
                    console.log(chalk.cyan('  c/clear    ⬢ Clear console'));
                    console.log(chalk.cyan('  ad         ⬢ Add admin via terminal'));
                    console.log(chalk.cyan('  rd         ⬢ Remove admin via terminal'));
                    console.log(chalk.cyan('  phone      ⬢ Switch to phone login'));
                    console.log(chalk.cyan('  q/quit     ⬢ Exit bot'));
                    console.log(chalk.cyan('  rst        ⬢ Restart bot'));
                    break;
                case 'ad':
                    console.log(chalk.yellow('⬢ Add Admin Mode'));
                    console.log(chalk.cyan('Enter phone number (with country code, no +):'));
                    this.terminalMode = 'admin_input';
                    break;
                case 'rd':
                    console.log(chalk.yellow('⬢ Remove Admin Mode'));
                    console.log(chalk.cyan('Current admins:'));
                    let count = 1;
                    for (const adminId of this.admins) {
                        const user = this.users.get(adminId);
                        const name = user ? user.name : adminId;
                        console.log(chalk.cyan(`  ${count}. ${name} (${adminId})`));
                        count++;
                    }
                    console.log(chalk.cyan('Enter admin number to remove:'));
                    this.terminalMode = 'admin_remove';
                    break;
                case 'r':
                case 'reload':
                    console.log(chalk.yellow('⬢ Reloading modules...'));
                    this.loadModules();
                    break;
                case 'rst':
                case 'restart':
                    await this.performRestart();
                    break;
                case 's':
                case 'status':
                    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
                    const memory = process.memoryUsage();
                    const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
                    const sysInfo = this.getSystemInfo();
                    console.log(chalk.green('⬢ Bot Status:'));
                    console.log(chalk.cyan(`  Connection: ${this.isAuthenticated ? 'Connected' : 'Disconnected'}`));
                    console.log(chalk.cyan(`  Login Method: ${this.loginMethod}`));
                    console.log(chalk.cyan(`  Uptime: ${uptime}s`));
                    console.log(chalk.cyan(`  Memory: ${memUsed}MB`));
                    console.log(chalk.cyan(`  System: ${sysInfo.distro}`));
                    console.log(chalk.cyan(`  CPU: ${sysInfo.cpuCores} cores`));
                    console.log(chalk.cyan(`  Users: ${this.users.size}`));
                    console.log(chalk.cyan(`  Messages: ${this.messageCount}`));
                    console.log(chalk.cyan(`  Modules: ${this.modules.size}`));
                    console.log(chalk.cyan(`  Admins: ${this.admins.size}`));
                    console.log(chalk.cyan(`  Scheduled: ${this.scheduledMessages.size}`));
                    if (this.phoneNumber) {
                        console.log(chalk.cyan(`  Phone: ${this.phoneNumber}`));
                    }
                    if (this.pairingCode) {
                        console.log(chalk.cyan(`  Last Code: ${this.pairingCode}`));
                    }
                    break;
                case 'm':
                case 'modules':
                    console.log(chalk.yellow('⬢ Loaded Modules:'));
                    for (const [name, module] of this.modules) {
                        const prefix = module.adminOnly ? chalk.red('⬤') : chalk.green('⬢');
                        const hidden = module.hideFromList ? chalk.gray(' (hidden)') : '';
                        console.log(`  ${prefix} ${name} - ${module.description}${hidden}`);
                    }
                    break;
                case 'u':
                case 'users':
                    console.log(chalk.yellow(`⬢ Users (${this.users.size}):`));
                    let userCount = 0;
                    for (const [id, user] of this.users) {
                        if (userCount < 20) {
                            const prefix = user.isAdmin ? chalk.red('⬤') : chalk.green('⬢');
                            console.log(`  ${prefix} ${user.name} (${id}) - ${user.messageCount} msgs`);
                            userCount++;
                        }
                    }
                    if (this.users.size > 20) {
                        console.log(chalk.gray(`  ... and ${this.users.size - 20} more`));
                    }
                    break;
                case 'a':
                case 'admins':
                    console.log(chalk.yellow(`⬢ Admins (${this.admins.size}):`));
                    let adminCount = 1;
                    for (const adminId of this.admins) {
                        const user = this.users.get(adminId);
                        const name = user ? user.name : adminId;
                        console.log(chalk.red(`  ${adminCount}. ${name} (${adminId})`));
                        adminCount++;
                    }
                    break;
                case 'l':
                case 'logs':
                    try {
                        const logContent = fs.readFileSync(this.logFile, 'utf8');
                        const lines = logContent.split('\n').slice(-10);
                        console.log(chalk.yellow('⬢ Recent Logs:'));
                        lines.forEach(line => {
                            if (line.trim()) {
                                console.log(chalk.gray(`  ${line}`));
                            }
                        });
                    } catch (error) {
                        console.log(chalk.red('⚠ No logs available'));
                    }
                    break;
                case 'c':
                case 'clear':
                    console.clear();
                    this.showHeader();
                    console.log(chalk.green('⬢ Console cleared'));
                    break;
                case 'q':
                case 'quit':
                    await this.performShutdown();
                    break;
                case '':
                    if (this.isAuthenticated) {
                        console.log(chalk.green('⬢ Bot is running'));
                    } else {
                        console.log(chalk.yellow('⬢ Reconnecting...'));
                        this.client.initialize();
                    }
                    break;
                default:
                    console.log(chalk.red(`⚠ Unknown command: ${command}`));
                    console.log(chalk.gray('Type "h" for help'));
            }
            this.rl.prompt();
        });
        this.rl.prompt();
    }

    async performRestart() {
        if (this.restartInProgress) {
            console.log(chalk.yellow('⬢ Restart already in progress'));
            return;
        }
        
        this.restartInProgress = true;
        console.log(chalk.yellow('⬢ Restarting bot...'));
        this.log('Bot manual restart initiated');
        
        try {
            this.saveUsers();
            this.saveAdmins();
            this.saveScheduledMessages();
            
            if (this.watcher) {
                this.watcher.close();
                this.watcher = null;
            }
            
            if (this.rl) {
                this.rl.close();
            }
            
            await this.client.destroy();
            
            clearInterval(this.progressInterval);
            
            this.isAuthenticated = false;
            this.messageQueue = [];
            this.isProcessingQueue = false;
            
            setTimeout(() => {
                this.createClient();
                this.setupEventHandlers();
                this.setupWatcher();
                this.setupTerminalCommands();
                this.start();
                this.restartInProgress = false;
            }, 2000);
            
        } catch (error) {
            this.log(`Error during restart: ${error.message}`, 'ERROR');
            console.log(chalk.red('⚠ Restart failed:', error.message));
            this.restartInProgress = false;
        }
    }

    async performShutdown() {
        console.log(chalk.yellow('⬢ Shutting down bot...'));
        this.log('Bot shutting down');
        
        try {
            this.saveUsers();
            this.saveAdmins();
            this.saveScheduledMessages();
            
            if (this.watcher) {
                this.watcher.close();
            }
            
            if (this.rl) {
                this.rl.close();
            }
            
            await this.client.destroy();
            
            clearInterval(this.progressInterval);
            
            process.exit(0);
        } catch (error) {
            this.log(`Error during shutdown: ${error.message}`, 'ERROR');
            process.exit(1);
        }
    }

    restart() {
        if (this.restartInProgress) return;
        
        console.log(chalk.yellow('⬢ Restarting bot...'));
        this.log('Bot auto restart');
        this.restartInProgress = true;
        
        setTimeout(() => {
            this.isAuthenticated = false;
            this.client.initialize();
            this.restartInProgress = false;
        }, 3000);
    }

    start() {
        console.clear();
        this.showHeader();
        console.log(chalk.yellow('⬢ Starting WhatsApp Bot...'));
        console.log(chalk.cyan(`⬢ Login method: ${this.loginMethod}`));
        if (this.loginMethod === 'qr') {
            console.log(chalk.gray('Type "phone" to switch to phone number login'));
        }
        this.log('Bot starting');
        global.botInstance = this;
        this.client.initialize();
    }
}

process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n⬢ Shutting down bot...'));
    if (global.botInstance) {
        await global.botInstance.performShutdown();
    } else {
        process.exit(0);
    }
});

process.on('uncaughtException', (error) => {
    console.log(chalk.red('⚠ Uncaught Exception:', error.message));
    if (global.botInstance) {
        global.botInstance.log(`Uncaught Exception: ${error.message}`, 'ERROR');
        global.botInstance.saveUsers();
        global.botInstance.saveAdmins();
        global.botInstance.saveScheduledMessages();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.log(chalk.red('⚠ Unhandled Rejection:', reason));
    if (global.botInstance) {
        global.botInstance.log(`Unhandled Rejection: ${reason}`, 'ERROR');
    }
});

const bot = new WABot();
bot.start();

module.exports = WABot;
