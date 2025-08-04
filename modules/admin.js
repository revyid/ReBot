module.exports = {
    name: 'admin',
    description: 'Admin management commands',
    adminOnly: true,
    hideFromList: false,
    
    async execute(message, args, client, bot) {
        if (args.length === 0) {
            const adminList = Array.from(bot.users.entries())
                .filter(([id, user]) => user.isAdmin)
                .map(([id, user]) => `${bot.config.symbols.admin} ${bot.getContactName(id)} (${id})`)
                .join('\n');
            
            await message.reply(`${bot.config.symbols.system} Admin List:\n${adminList}`);
            return;
        }
        
        const action = args[0].toLowerCase();
        const phoneNumber = args[1]?.replace(/\D/g, '');
        
        if (!phoneNumber) {
            await message.reply(`${bot.config.symbols.warning} Please provide a phone number`);
            return;
        }
        
        switch (action) {
            case 'add':
                if (bot.users.has(phoneNumber)) {
                    bot.users.get(phoneNumber).isAdmin = true;
                    bot.saveUsers();
                    await message.reply(`${bot.config.symbols.success} Admin added: ${bot.getContactName(phoneNumber)}`);
                } else {
                    await message.reply(`${bot.config.symbols.error} User not found`);
                }
                break;
                
            case 'remove':
                if (phoneNumber === bot.botNumber) {
                    await message.reply(`${bot.config.symbols.error} Cannot remove bot owner`);
                    return;
                }
                if (bot.users.has(phoneNumber)) {
                    bot.users.get(phoneNumber).isAdmin = false;
                    bot.saveUsers();
                    await message.reply(`${bot.config.symbols.success} Admin removed: ${bot.getContactName(phoneNumber)}`);
                } else {
                    await message.reply(`${bot.config.symbols.error} User not found`);
                }
                break;
                
            default:
                await message.reply(`${bot.config.symbols.info} Usage: .admin [add|remove] <phone_number>`);
        }
    }
};