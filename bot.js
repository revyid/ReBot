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
        this.messageCount = 0;
        this.sessionId = this.generateSessionId();
        this.terminalMode = 'normal';
        this.pendingAdminAdd = null;
        this.pendingAdminRemove = null;
        this.pendingNumberAdd = null;
        this.pendingContactAdd = null;
        this.watcher = null;
        this.isReloading = false;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.rateLimits = new Map();
        this.cooldowns = new Map();
        this.scheduledMessages = new Map();
        this.loginMethod = 'qr';
        this.phoneNumber = null;
        this.pairingCode = null;
        this.isAuthenticated = false;
        this.restartInProgress = false;
        this.modules = new Map();
        this.runningTasks = new Set();
        this.maxConcurrentTasks = 3;
        this.botNumber = null;
        this.botName = null;
        this.contactList = new Map();
        this.allowSelfCommands = true;
        this.forceExit = false;
        this.shutdownInProgress = false;
        this.authTimeout = null;
        this.qrRetries = 0;
        this.maxQrRetries = 3;
        this.contactSyncInterval = null;
        
        this.dataDir = path.join(__dirname, 'data');
        this.usersFile = path.join(this.dataDir, 'users.json');
        this.scheduledMessagesFile = path.join(this.dataDir, 'scheduled.json');
        this.configFile = path.join(this.dataDir, 'config.json');
        this.logFile = path.join(__dirname, 'logs', `session_${this.sessionId}.log`);
        
        this.config = {
            symbols: {
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
                user: '👤',
                admin: '👑',
                message: '💬',
                command: '⚡',
                data: '📊',
                terminal: '⌘',
                self: '🤖'
            },
            settings: {
                rateLimitEnabled: true,
                typingSimulation: true,
                logLevel: 'INFO',
                authTimeout: 60000,
                fastAuth: true,
                autoContactSync: true,
                contactSyncInterval: 30000
            }
        };
        
        this.init();
    }

    init() {
        this.setupDirectories();
        this.loadConfig();
        this.loadPersistentData();
        this.loadContacts();
        this.setupLogger();
        this.createClient();
        this.setupEventHandlers();
        this.loadModules();
        this.setupWatcher();
        this.setupTerminalCommands();
        this.setupRateLimit();
        this.setupMessageScheduler();
        this.setupContactSync();
    }

    generateSessionId() {
        const now = new Date();
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    }

    setupDirectories() {
        const dirs = [
            this.dataDir,
            path.join(this.dataDir, 'raw'),
            path.join(__dirname, 'logs'),
            path.join(__dirname, 'session'),
            path.join(__dirname, 'modules')
        ];
        
        dirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    loadConfig() {
        try {
            if (fs.existsSync(this.configFile)) {
                const config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
                this.config = { ...this.config, ...config };
            } else {
                this.saveConfig();
            }
        } catch (error) {
            this.log(`Error loading config: ${error.message}`, 'ERROR');
        }
    }

    saveConfig() {
        try {
            fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
        } catch (error) {
            this.log(`Error saving config: ${error.message}`, 'ERROR');
        }
    }

    createClient() {
        const sessionDir = path.join(__dirname, 'session');
        this.cleanupSession(sessionDir);

        const authStrategy = this.loginMethod === 'phone' ? new NoAuth() : new LocalAuth({ 
            clientId: 'WhatsApp-bot', 
            dataPath: sessionDir
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
                    '--disable-features=VizDisplayCompositor',
                    '--single-process',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-sync',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-default-apps',
                    '--disable-component-update'
                ],
                executablePath: this.getChromePath(),
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false
            },
            restartOnAuthFail: false,
            qrMaxRetries: this.maxQrRetries,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 0
        });
    }

    cleanupSession(sessionDir) {
        try {
            const lockFile = path.join(sessionDir, 'session-WhatsApp-bot', 'SingletonLock');
            if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                this.log('Removed existing session lock');
            }
        } catch (error) {
            this.log(`Session cleanup warning: ${error.message}`, 'WARNING');
        }
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

    setupRateLimit() {
        this.rateLimitWindow = 60 * 1000;
        this.rateLimitMax = 10;
        this.cooldownPeriod = 5 * 60 * 1000;
        this.messageDelay = 300;
    }

    setupMessageScheduler() {
        setInterval(() => {
            if (this.shutdownInProgress) return;
            
            const now = Date.now();
            for (const [id, { recipient, message, timestamp }] of this.scheduledMessages) {
                if (timestamp.getTime() <= now) {
                    this.client.sendMessage(recipient, message)
                        .then(() => {
                            this.scheduledMessages.delete(id);
                            this.saveScheduledMessages();
                            this.log(`Scheduled message sent to ${recipient}`);
                        })
                        .catch(error => {
                            this.log(`Error sending scheduled message: ${error.message}`, 'ERROR');
                        });
                }
            }
        }, 60000);
    }

    setupContactSync() {
        if (!this.config.settings.autoContactSync) return;
        
        this.contactSyncInterval = setInterval(async () => {
            if (this.shutdownInProgress || !this.isAuthenticated) return;
            
            try {
                await this.syncContacts();
            } catch (error) {
                this.log(`Contact sync error: ${error.message}`, 'ERROR');
            }
        }, this.config.settings.contactSyncInterval);
    }

    async syncContacts() {
        if (!this.client || !this.isAuthenticated) return;
        
        try {
            const contacts = await this.client.getContacts();
            let updated = false;
            
            for (const contact of contacts) {
                if (contact.id.user && contact.name && !contact.isGroup) {
                    const currentName = this.contactList.get(contact.id.user);
                    if (currentName !== contact.name) {
                        this.contactList.set(contact.id.user, contact.name);
                        updated = true;
                        
                        if (this.users.has(contact.id.user)) {
                            const user = this.users.get(contact.id.user);
                            user.name = contact.name;
                        }
                    }
                }
            }
            
            if (updated) {
                this.saveContacts();
                this.saveUsers();
                this.log('Contacts synchronized');
            }
        } catch (error) {
            this.log(`Sync contacts failed: ${error.message}`, 'ERROR');
        }
    }

    async checkRateLimit(userId) {
        if (!this.config.settings.rateLimitEnabled) return true;
        
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
            if (this.loginMethod === 'qr' && !this.shutdownInProgress) {
                this.qrRetries++;
                console.clear();
                this.showHeader();
                console.log(chalk.yellow(`${this.config.symbols.system} Scan QR Code (${this.qrRetries}/${this.maxQrRetries})`));
                qrcode.generate(qr, { small: true });
                console.log(chalk.gray('Press ENTER to refresh or type "phone" for phone login'));
                this.log(`QR Code generated (attempt ${this.qrRetries})`);
                
                if (this.qrRetries >= this.maxQrRetries) {
                    this.log('Max QR retries reached, switching to phone login', 'WARNING');
                    setTimeout(() => {
                        this.loginMethod = 'phone';
                        this.restart();
                    }, 5000);
                }
            }
        });

        this.client.on('authenticated', () => {
            this.isAuthenticated = true;
            this.qrRetries = 0;
            this.log('Authentication successful');
            
            if (this.authTimeout) {
                clearTimeout(this.authTimeout);
                this.authTimeout = null;
            }
        });

        this.client.on('ready', async () => {
            if (this.shutdownInProgress) return;
            
            console.clear();
            this.showHeader();
            
            const info = this.client.info;
            this.botNumber = info.wid.user;
            this.botName = info.pushname;
            
            console.log(chalk.green(`${this.config.symbols.success} Bot connected successfully`));
            console.log(chalk.cyan(`${this.config.symbols.user} Name: ${info.pushname}`));
            console.log(chalk.cyan(`${this.config.symbols.network} Number: ${info.wid.user}`));
            console.log(chalk.cyan(`${this.config.symbols.info} Method: ${this.loginMethod.toUpperCase()}`));
            console.log(chalk.yellow(`${this.config.symbols.status} Ready to receive messages`));
            console.log(chalk.gray('Type "h" for help'));
            
            this.log(`Bot connected as ${info.pushname} (${info.wid.user})`);
            
            if (!this.users.has(info.wid.user)) {
                this.users.set(info.wid.user, {
                    id: info.wid.user,
                    name: info.pushname,
                    firstSeen: new Date(),
                    messageCount: 0,
                    isAdmin: true,
                    lastActive: new Date()
                });
            } else {
                const user = this.users.get(info.wid.user);
                user.isAdmin = true;
                user.lastActive = new Date();
            }
            
            this.saveUsers();
            this.isAuthenticated = true;
            
            if (this.authTimeout) {
                clearTimeout(this.authTimeout);
                this.authTimeout = null;
            }
            
            if (this.config.settings.autoContactSync) {
                setTimeout(() => this.syncContacts(), 5000);
            }
        });

        this.client.on('message', async (message) => {
            if (this.shutdownInProgress || message.type === 'ciphertext' || message.type === 'protocol' || !message.body) {
                return;
            }
            
            this.processMessage(message);
        });

        this.client.on('message_create', async (message) => {
            if (this.shutdownInProgress || !message.fromMe || !this.allowSelfCommands || !message.body.startsWith('.')) {
                return;
            }
            
            this.processMessage(message);
        });

        this.client.on('disconnected', (reason) => {
            if (this.shutdownInProgress) return;
            
            this.log(`Bot disconnected: ${reason}`, 'ERROR');
            console.log(chalk.red(`${this.config.symbols.error} Disconnected: ${reason}`));
            this.isAuthenticated = false;
            
            if (!this.restartInProgress) {
                this.restart();
            }
        });

        this.client.on('auth_failure', (msg) => {
            this.log(`Authentication failure: ${msg}`, 'ERROR');
            console.log(chalk.red(`${this.config.symbols.error} Auth failure: ${msg}`));
            this.isAuthenticated = false;
            
            if (this.authTimeout) {
                clearTimeout(this.authTimeout);
                this.authTimeout = null;
            }
            
            if (!this.restartInProgress) {
                setTimeout(() => this.restart(), 2000);
            }
        });
    }

    processMessage(message) {
        if (this.runningTasks.size < this.maxConcurrentTasks) {
            const taskId = uuidv4();
            this.runningTasks.add(taskId);
            
            this.handleMessage(message, taskId).finally(() => {
                this.runningTasks.delete(taskId);
            });
        } else {
            this.messageQueue.push(message);
            if (!this.isProcessingQueue) {
                this.startMessageQueue();
            }
        }
    }

    async startMessageQueue() {
        this.isProcessingQueue = true;
        while (this.messageQueue.length > 0 && this.runningTasks.size < this.maxConcurrentTasks && !this.shutdownInProgress) {
            const message = this.messageQueue.shift();
            const taskId = uuidv4();
            this.runningTasks.add(taskId);
            
            this.handleMessage(message, taskId).finally(() => {
                this.runningTasks.delete(taskId);
            });
            
            await new Promise(resolve => setTimeout(resolve, this.messageDelay));
        }
        this.isProcessingQueue = false;
    }

    showHeader() {
        console.log(chalk.red(this.config.symbols.status), chalk.yellow(this.config.symbols.status), chalk.green(this.config.symbols.status));
        console.log(chalk.cyan('    ____'));
        console.log(chalk.cyan(`   / __ \\___ _   ____  __`));
        console.log(chalk.cyan(`  / /_/ / _ \\ | / / / / /`));
        console.log(chalk.cyan(` / _, _/  __/ |/ / /_/ /`));
        console.log(chalk.cyan(`/_/ |_|\\___/|___/\\__, /`));
        console.log(chalk.cyan(`                /____/`));
        console.log();
        console.log(chalk.gray(new Date().toString()));
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.cyan(`${this.config.symbols.system} WhatsApp Bot v8.1 Stable`));
        console.log(chalk.gray('─'.repeat(60)));
    }

    isAdmin(userId) {
        const user = this.users.get(userId);
        return user && user.isAdmin;
    }

    async handleMessage(message, taskId) {
        try {
            if (this.shutdownInProgress) return;
            
            this.messageCount++;
            const chat = await message.getChat();
            const contact = await message.getContact();
            let userId = contact.id.user;
            const isCommand = message.body.startsWith('.');
            const isSelfMessage = message.fromMe;
            
            if (isSelfMessage && this.botNumber) {
                userId = this.botNumber;
            }

            if (!this.users.has(userId)) {
                const contactName = this.getContactName(userId);
                this.users.set(userId, {
                    id: userId,
                    name: contactName,
                    firstSeen: new Date(),
                    messageCount: 0,
                    isAdmin: userId === this.botNumber,
                    lastActive: new Date()
                });
                this.log(`New user: ${contactName} (${userId})`);
                this.saveUsers();
            }

            const user = this.users.get(userId);
            user.messageCount++;
            user.lastActive = new Date();

            const displayName = this.getContactName(userId);
            const timestamp = new Date().toLocaleTimeString();
            let chatInfo = '';
            
            if (isSelfMessage) {
                if (chat.isGroup) {
                    chatInfo = ` → ${chat.name}`;
                } else {
                    const chatContact = await this.client.getContactById(chat.id._serialized);
                    const chatContactName = this.getContactName(chatContact.id.user);
                    chatInfo = ` → ${chatContactName}`;
                }
                console.log(chalk.magenta(`[${timestamp}] ${this.config.symbols.self} ${this.botName || displayName}${chatInfo}: ${message.body}`));
            } else {
                console.log(chalk.blue(`[${timestamp}] ${this.config.symbols.message} ${displayName}: ${message.body}`));
            }

            if (isCommand) {
                if (!isSelfMessage && !(await this.checkRateLimit(userId))) {
                    this.log(`Rate limit exceeded for ${userId}`, 'WARNING');
                    return;
                }

                if (this.config.settings.typingSimulation) {
                    await this.simulateTyping(chat);
                }
                
                const [command, ...args] = message.body.slice(1).split(' ');
                if (this.modules.has(command)) {
                    const module = this.modules.get(command);
                    if (module.adminOnly && !this.isAdmin(userId)) {
                        await message.reply(`${this.config.symbols.warning} Admin access required`);
                        return;
                    }
                    try {
                        await module.execute(message, args, this.client, this);
                        this.log(`Command executed: ${command} by ${userId}`);
                    } catch (error) {
                        console.log(chalk.red(`${this.config.symbols.error} Error executing ${command}: ${error.message}`));
                        this.log(`Error executing ${command}: ${error.message}`, 'ERROR');
                        await message.reply(`${this.config.symbols.warning} Command error occurred`);
                    }
                }
            }

            for (const [name, module] of this.modules) {
                if (module.autoTrigger && module.autoTrigger(message)) {
                    if (this.config.settings.typingSimulation) {
                        await this.simulateTyping(chat);
                    }
                    try {
                        await module.execute(message, [], this.client, this);
                    } catch (error) {
                        this.log(`Error in auto trigger ${name}: ${error.message}`, 'ERROR');
                    }
                }
            }
        } catch (error) {
            this.log(`Error handling message: ${error.message}`, 'ERROR');
        }
    }

    async simulateTyping(chat) {
        if (!this.config.settings.typingSimulation) return;
        
        try {
            await chat.sendStateTyping();
            await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500));
        } catch (error) {
            this.log(`Error simulating typing: ${error.message}`, 'ERROR');
        }
    }

    loadModules() {
        if (this.isReloading) return;
        this.isReloading = true;
        
        const modulesPath = path.join(__dirname, 'modules');
        if (!fs.existsSync(modulesPath)) {
            fs.mkdirSync(modulesPath, { recursive: true });
            this.isReloading = false;
            return;
        }
        
        const files = fs.readdirSync(modulesPath).filter(file => file.endsWith('.js'));
        this.modules.clear();
        
        for (const file of files) {
            try {
                delete require.cache[require.resolve(path.join(modulesPath, file))];
                const module = require(path.join(modulesPath, file));
                this.modules.set(module.name, module);
                console.log(chalk.green(`${this.config.symbols.success} Loaded: ${module.name}`));
                this.log(`Module loaded: ${module.name}`);
            } catch (error) {
                console.log(chalk.red(`${this.config.symbols.error} Error loading ${file}: ${error.message}`));
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
        
        this.watcher = chokidar.watch(modulesPath, { 
            ignored: /[\/\\]\./, 
            persistent: true, 
            ignoreInitial: true 
        });
        
        this.watcher.on('change', () => {
            if (!this.isReloading && !this.shutdownInProgress) {
                console.log(chalk.yellow(`${this.config.symbols.system} Module changed, reloading modules...`));
                this.loadModules();
            }
        });
        
        this.watcher.on('add', () => {
            if (!this.isReloading && !this.shutdownInProgress) {
                console.log(chalk.green(`${this.config.symbols.system} New module added`));
                this.loadModules();
            }
        });
        
        this.watcher.on('unlink', () => {
            if (!this.isReloading && !this.shutdownInProgress) {
                console.log(chalk.red(`${this.config.symbols.system} Module removed`));
                this.loadModules();
            }
        });
    }

    loadPersistentData() {
        try {
            if (fs.existsSync(this.usersFile)) {
                const usersData = JSON.parse(fs.readFileSync(this.usersFile, 'utf8'));
                for (const [id, userData] of Object.entries(usersData.users || {})) {
                    this.users.set(id, {
                        ...userData,
                        firstSeen: new Date(userData.firstSeen),
                        lastActive: userData.lastActive ? new Date(userData.lastActive) : new Date()
                    });
                }
            }

            if (fs.existsSync(this.scheduledMessagesFile)) {
                const scheduledData = JSON.parse(fs.readFileSync(this.scheduledMessagesFile, 'utf8'));
                for (const [id, messageData] of Object.entries(scheduledData.messages || {})) {
                    this.scheduledMessages.set(id, {
                        ...messageData,
                        timestamp: new Date(messageData.timestamp)
                    });
                }
            }
        } catch (error) {
            this.log(`Error loading persistent data: ${error.message}`, 'ERROR');
        }
    }

    saveUsers() {
        try {
            const usersData = {
                lastUpdated: new Date().toISOString(),
                count: this.users.size,
                users: Object.fromEntries(
                    Array.from(this.users.entries()).map(([id, user]) => [
                        id,
                        {
                            ...user,
                            firstSeen: user.firstSeen.toISOString(),
                            lastActive: user.lastActive?.toISOString() || new Date().toISOString()
                        }
                    ])
                )
            };
            fs.writeFileSync(this.usersFile, JSON.stringify(usersData, null, 2));
        } catch (error) {
            this.log(`Error saving users: ${error.message}`, 'ERROR');
        }
    }

    saveScheduledMessages() {
        try {
            const scheduledData = {
                lastUpdated: new Date().toISOString(),
                count: this.scheduledMessages.size,
                messages: Object.fromEntries(
                    Array.from(this.scheduledMessages.entries()).map(([id, message]) => [
                        id,
                        {
                            ...message,
                            timestamp: message.timestamp.toISOString()
                        }
                    ])
                )
            };
            fs.writeFileSync(this.scheduledMessagesFile, JSON.stringify(scheduledData, null, 2));
        } catch (error) {
            this.log(`Error saving scheduled messages: ${error.message}`, 'ERROR');
        }
    }

    setupLogger() {
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    }

    log(message, type = 'INFO') {
        if (this.config.settings.logLevel === 'ERROR' && type !== 'ERROR') return;
        
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            type,
            message,
            sessionId: this.sessionId
        };
        
        try {
            fs.appendFileSync(this.logFile, JSON.stringify(logEntry) + '\n');
        } catch (error) {}
    }

    loadContacts() {
        try {
            const contactsFile = path.join(this.dataDir, 'contacts.json');
            if (fs.existsSync(contactsFile)) {
                const contacts = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
                this.contactList = new Map(Object.entries(contacts));
            }
        } catch (error) {
            this.log(`Error loading contacts: ${error.message}`, 'ERROR');
        }
    }

    saveContacts() {
        try {
            const contactsFile = path.join(this.dataDir, 'contacts.json');
            const contactsObj = Object.fromEntries(this.contactList);
            fs.writeFileSync(contactsFile, JSON.stringify(contactsObj, null, 2));
        } catch (error) {
            this.log(`Error saving contacts: ${error.message}`, 'ERROR');
        }
    }

    getContactName(phoneNumber) {
        return this.contactList.get(phoneNumber) || phoneNumber;
    }

    addContact(phoneNumber, name) {
        this.contactList.set(phoneNumber, name);
        
        if (this.users.has(phoneNumber)) {
            const user = this.users.get(phoneNumber);
            user.name = name;
        }
        
        this.saveContacts();
        this.saveUsers();
    }

    exportData() {
        const exportData = {
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
            botNumber: this.botNumber,
            botName: this.botName,
            users: Object.fromEntries(
                Array.from(this.users.entries()).map(([id, user]) => [
                    id,
                    {
                        ...user,
                        firstSeen: user.firstSeen.toISOString(),
                        lastActive: user.lastActive?.toISOString()
                    }
                ])
            ),
            contacts: Object.fromEntries(this.contactList),
            scheduledMessages: Object.fromEntries(
                Array.from(this.scheduledMessages.entries()).map(([id, msg]) => [
                    id,
                    {
                        ...msg,
                        timestamp: msg.timestamp.toISOString()
                    }
                ])
            ),
            config: this.config,
            stats: {
                totalMessages: this.messageCount,
                uptime: Date.now() - this.startTime,
                totalUsers: this.users.size,
                totalContacts: this.contactList.size
            }
        };

        const exportPath = path.join(this.dataDir, `export_${this.sessionId}.json`);
        fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
        return exportPath;
    }

    setupTerminalCommands() {
        this.rl = readline.createInterface({ 
            input: process.stdin, 
            output: process.stdout, 
            prompt: chalk.gray(`${this.config.symbols.terminal} `),
            completer: (line) => {
                const completions = ['h', 'help', 'r', 'reload', 's', 'status', 'm', 'modules', 'u', 'users', 'a', 'admins', 'l', 'logs', 'c', 'clear', 'phone', 'contact', 'sync', 'q', 'quit', 'rst', 'fexit'];
                const hits = completions.filter((c) => c.startsWith(line));
                return [hits.length ? hits : completions, line];
            }
        });
        
        this.rl.on('line', async (input) => {
            if (this.shutdownInProgress) return;
            
            const command = input.trim().toLowerCase();
            
            if (!command && this.terminalMode === 'normal') {
                if (this.isAuthenticated) {
                    console.log(chalk.green(`${this.config.symbols.success} Bot is running`));
                } else {
                    console.log(chalk.yellow(`${this.config.symbols.system} Reconnecting...`));
                    this.client.initialize();
                }
                this.rl.prompt();
                return;
            }
            
            if (this.terminalMode === 'phone_input') {
                const phoneNumber = command.replace(/\D/g, '');
                if (phoneNumber.length >= 10) {
                    try {
                        console.log(chalk.yellow(`${this.config.symbols.system} Requesting pairing code...`));
                        this.pairingCode = await this.requestPairingCode(phoneNumber);
                        console.log(chalk.green(`${this.config.symbols.success} Pairing code: ${this.pairingCode}`));
                        console.log(chalk.cyan(`${this.config.symbols.info} Enter this code in WhatsApp`));
                        this.phoneNumber = phoneNumber;
                        this.loginMethod = 'phone';
                        this.terminalMode = 'normal';
                        this.log(`Pairing code requested: ${this.pairingCode}`);
                    } catch (error) {
                        console.log(chalk.red(`${this.config.symbols.error} Failed to request pairing code`));
                        this.terminalMode = 'normal';
                    }
                } else {
                    console.log(chalk.red(`${this.config.symbols.warning} Invalid phone number`));
                }
                this.rl.prompt();
                return;
            }

            if (this.terminalMode === 'contact_number') {
                const phoneNumber = command.replace(/\D/g, '');
                if (phoneNumber.length >= 10) {
                    this.pendingContactAdd = { number: phoneNumber };
                    console.log(chalk.cyan('Enter contact name:'));
                    this.terminalMode = 'contact_name';
                } else {
                    console.log(chalk.red(`${this.config.symbols.warning} Invalid phone number`));
                    this.terminalMode = 'normal';
                }
                this.rl.prompt();
                return;
            }

            if (this.terminalMode === 'contact_name') {
                const name = input.trim();
                if (name && this.pendingContactAdd) {
                    this.addContact(this.pendingContactAdd.number, name);
                    console.log(chalk.green(`${this.config.symbols.success} Contact added: ${name} (${this.pendingContactAdd.number})`));
                    this.log(`Contact added: ${name} (${this.pendingContactAdd.number})`);
                } else {
                    console.log(chalk.red(`${this.config.symbols.error} Invalid name`));
                }
                this.pendingContactAdd = null;
                this.terminalMode = 'normal';
                this.rl.prompt();
                return;
            }

            switch (command) {
                case 'phone':
                    if (!this.isAuthenticated) {
                        console.log(chalk.yellow(`${this.config.symbols.system} Phone Login Mode`));
                        console.log(chalk.cyan('Enter phone number (with country code, no +):'));
                        this.terminalMode = 'phone_input';
                    } else {
                        console.log(chalk.red(`${this.config.symbols.error} Already authenticated`));
                    }
                    break;

                case 'contact':
                    console.log(chalk.yellow(`${this.config.symbols.system} Add Contact Mode`));
                    console.log(chalk.cyan('Enter phone number (with country code, no +):'));
                    this.terminalMode = 'contact_number';
                    break;

                case 'sync':
                    if (this.isAuthenticated) {
                        console.log(chalk.yellow(`${this.config.symbols.system} Syncing contacts...`));
                        try {
                            await this.syncContacts();
                            console.log(chalk.green(`${this.config.symbols.success} Contacts synchronized`));
                        } catch (error) {
                            console.log(chalk.red(`${this.config.symbols.error} Sync failed: ${error.message}`));
                        }
                    } else {
                        console.log(chalk.red(`${this.config.symbols.error} Not authenticated`));
                    }
                    break;

                case 'h':
                case 'help':
                    console.log(chalk.yellow(`${this.config.symbols.system} Terminal Commands:`));
                    console.log(chalk.cyan(`  h/help     ${this.config.symbols.info} Show this help`));
                    console.log(chalk.cyan(`  r/reload   ${this.config.symbols.system} Reload modules`));
                    console.log(chalk.cyan(`  s/status   ${this.config.symbols.status} Show bot status`));
                    console.log(chalk.cyan(`  m/modules  ${this.config.symbols.command} List modules`));
                    console.log(chalk.cyan(`  u/users    ${this.config.symbols.user} Show users`));
                    console.log(chalk.cyan(`  a/admins   ${this.config.symbols.admin} Show admins`));
                    console.log(chalk.cyan(`  l/logs     ${this.config.symbols.data} Show logs`));
                    console.log(chalk.cyan(`  c/clear    ${this.config.symbols.terminal} Clear console`));
                    console.log(chalk.cyan(`  phone      ${this.config.symbols.network} Phone login`));
                    console.log(chalk.cyan(`  contact    ${this.config.symbols.user} Add contact`));
                    console.log(chalk.cyan(`  sync       ${this.config.symbols.network} Sync contacts`));
                    console.log(chalk.cyan(`  q/quit     ${this.config.symbols.error} Exit bot`));
                    console.log(chalk.cyan(`  rst        ${this.config.symbols.system} Restart bot`));
                    console.log(chalk.cyan(`  fexit      ${this.config.symbols.error} Force exit`));
                    break;

                case 'fexit':
                    console.log(chalk.red(`${this.config.symbols.error} FORCE EXIT`));
                    this.log('Force exit requested');
                    this.forceExit = true;
                    if (this.rl) this.rl.close();
                    process.exit(2);
                    break;

                case 'r':
                case 'reload':
                    console.log(chalk.yellow(`${this.config.symbols.system} Reloading modules...`));
                    this.loadModules();
                    break;

                case 'rst':
                case 'restart':
                    console.log(chalk.yellow(`${this.config.symbols.system} Restarting...`));
                    this.log('Bot restart requested');
                    process.exit(99);
                    break;

                case 's':
                case 'status':
                    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
                    const memory = process.memoryUsage();
                    const memUsed = (memory.heapUsed / 1024 / 1024).toFixed(2);
                    const adminCount = Array.from(this.users.values()).filter(user => user.isAdmin).length;
                    
                    console.log(chalk.green(`${this.config.symbols.success} Bot Status:`));
                    console.log(chalk.cyan(`  ${this.config.symbols.network} Connected: ${this.isAuthenticated ? 'Yes' : 'No'}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.system} Method: ${this.loginMethod.toUpperCase()}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.self} Number: ${this.botNumber || 'Unknown'}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.user} Name: ${this.botName || 'Unknown'}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.status} Uptime: ${uptime}s`));
                    console.log(chalk.cyan(`  ${this.config.symbols.data} Memory: ${memUsed}MB`));
                    console.log(chalk.cyan(`  ${this.config.symbols.user} Users: ${this.users.size}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.message} Messages: ${this.messageCount}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.command} Modules: ${this.modules.size}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.admin} Admins: ${adminCount}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.system} Tasks: ${this.runningTasks.size}/${this.maxConcurrentTasks}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.data} Queue: ${this.messageQueue.length}`));
                    console.log(chalk.cyan(`  ${this.config.symbols.user} Contacts: ${this.contactList.size}`));
                    break;

                case 'm':
                case 'modules':
                    console.log(chalk.yellow(`${this.config.symbols.system} Loaded Modules:`));
                    for (const [name, module] of this.modules) {
                        const prefix = module.adminOnly ? chalk.red(this.config.symbols.admin) : chalk.green(this.config.symbols.command);
                        console.log(`  ${prefix} ${name} - ${module.description}`);
                    }
                    break;

                case 'u':
                case 'users':
                    console.log(chalk.yellow(`${this.config.symbols.system} Users (${this.users.size}):`));
                    let count = 0;
                    for (const [id, user] of this.users) {
                        if (count < 10) {
                            const prefix = user.isAdmin ? chalk.red(this.config.symbols.admin) : chalk.green(this.config.symbols.user);
                            const displayName = this.getContactName(id);
                            const selfIndicator = id === this.botNumber ? chalk.magenta(` [SELF]`) : '';
                            console.log(`  ${prefix} ${displayName} (${id}) - ${user.messageCount} msgs${selfIndicator}`);
                            count++;
                        }
                    }
                    if (this.users.size > 10) {
                        console.log(chalk.gray(`  ... and ${this.users.size - 10} more`));
                    }
                    break;

                case 'a':
                case 'admins':
                    const admins = Array.from(this.users.entries()).filter(([id, user]) => user.isAdmin);
                    console.log(chalk.yellow(`${this.config.symbols.system} Admins (${admins.length}):`));
                    for (const [adminId, user] of admins) {
                        const contactName = this.getContactName(adminId);
                        const selfIndicator = adminId === this.botNumber ? chalk.magenta(` [SELF]`) : '';
                        console.log(chalk.red(`  ${this.config.symbols.admin} ${contactName} (${adminId})${selfIndicator}`));
                    }
                    break;

                case 'l':
                case 'logs':
                    try {
                        const logContent = fs.readFileSync(this.logFile, 'utf8');
                        const lines = logContent.split('\n').slice(-5);
                        console.log(chalk.yellow(`${this.config.symbols.system} Recent Logs:`));
                        lines.forEach(line => {
                            if (line.trim()) {
                                try {
                                    const logEntry = JSON.parse(line);
                                    const time = new Date(logEntry.timestamp).toLocaleTimeString();
                                    const typeColor = logEntry.type === 'ERROR' ? chalk.red : logEntry.type === 'WARNING' ? chalk.yellow : chalk.gray;
                                    console.log(`  ${typeColor(`[${time}] ${logEntry.message}`)}`);
                                } catch {
                                    console.log(chalk.gray(`  ${line}`));
                                }
                            }
                        });
                    } catch (error) {
                        console.log(chalk.red(`${this.config.symbols.error} No logs available`));
                    }
                    break;

                case 'c':
                case 'clear':
                    console.clear();
                    this.showHeader();
                    console.log(chalk.green(`${this.config.symbols.success} Console cleared`));
                    break;

                case 'q':
                case 'quit':
                    await this.performShutdown();
                    break;

                default:
                    if (command) {
                        console.log(chalk.red(`${this.config.symbols.error} Unknown: ${command}`));
                        console.log(chalk.gray('Type "h" for help'));
                    }
            }
            this.rl.prompt();
        });
        
        this.rl.prompt();
    }

    async performShutdown() {
        if (this.shutdownInProgress) return;
        this.shutdownInProgress = true;
        
        console.log(chalk.yellow(`${this.config.symbols.system} Shutting down...`));
        this.log('Bot shutdown initiated');
        
        try {
            if (this.authTimeout) {
                clearTimeout(this.authTimeout);
            }
            
            if (this.contactSyncInterval) {
                clearInterval(this.contactSyncInterval);
            }
            
            this.saveUsers();
            this.saveScheduledMessages();
            this.saveContacts();
            this.saveConfig();
            
            if (this.watcher) {
                this.watcher.close();
            }
            
            if (this.rl) {
                this.rl.close();
            }
            
            if (this.client) {
                await this.client.destroy();
            }
            
            console.log(chalk.green(`${this.config.symbols.success} Shutdown complete`));
            process.exit(0);
        } catch (error) {
            this.log(`Error during shutdown: ${error.message}`, 'ERROR');
            process.exit(1);
        }
    }

    restart() {
        if (this.restartInProgress || this.shutdownInProgress) return;
        
        console.log(chalk.yellow(`${this.config.symbols.system} Restarting...`));
        this.log('Bot restart initiated');
        this.restartInProgress = true;
        
        setTimeout(() => {
            this.isAuthenticated = false;
            this.client.initialize();
            this.restartInProgress = false;
        }, 2000);
    }

    start() {
        console.clear();
        this.showHeader();
        console.log(chalk.yellow(`${this.config.symbols.system} Starting bot...`));
        console.log(chalk.cyan(`${this.config.symbols.network} Login: ${this.loginMethod.toUpperCase()}`));
        console.log(chalk.cyan(`${this.config.symbols.system} Max tasks: ${this.maxConcurrentTasks}`));
        
        if (this.loginMethod === 'qr') {
            console.log(chalk.gray('Type "phone" for phone login'));
        }
        
        this.log('Bot starting');
        global.botInstance = this;
        
        if (this.config.settings.fastAuth && this.config.settings.authTimeout > 0) {
            this.authTimeout = setTimeout(() => {
                if (!this.isAuthenticated) {
                    this.log('Authentication timeout reached', 'WARNING');
                    console.log(chalk.yellow(`${this.config.symbols.warning} Auth timeout, retrying...`));
                    this.restart();
                }
            }, this.config.settings.authTimeout);
        }
        
        this.client.initialize();
    }
}

process.on('SIGINT', async () => {
    if (global.botInstance && !global.botInstance.forceExit) {
        await global.botInstance.performShutdown();
    } else {
        process.exit(0);
    }
});

process.on('uncaughtException', (error) => {
    if (error.message.includes('Target closed') || error.message.includes('Session closed') || error.message.includes('Protocol error')) {
        console.log(chalk.gray(`${global.botInstance?.config?.symbols?.info || 'ℹ'} Browser session closed (normal during shutdown)`));
        return;
    }
    
    console.log(chalk.red(`${global.botInstance?.config?.symbols?.error || '❌'} Uncaught Exception: ${error.message}`));
    if (global.botInstance) {
        global.botInstance.log(`Uncaught Exception: ${error.message}`, 'ERROR');
        global.botInstance.saveUsers();
        global.botInstance.saveScheduledMessages();
        global.botInstance.saveContacts();
        global.botInstance.saveConfig();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    if (reason && (reason.toString().includes('Target closed') || reason.toString().includes('Session closed') || reason.toString().includes('Protocol error'))) {
        return;
    }
    
    console.log(chalk.yellow(`${global.botInstance?.config?.symbols?.warning || '⚠'} Unhandled Rejection: ${reason}`));
    if (global.botInstance) {
        global.botInstance.log(`Unhandled Rejection: ${reason}`, 'WARNING');
    }
});

const bot = new WABot();
bot.start();

module.exports = WABot;