module.exports = {
    name: 'addadmin',
    description: 'Add user as admin (reply to message)',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (!message.hasQuotedMsg) {
            return await message.reply('◑ Reply to a message to add admin');
        }
        const quotedMsg = await message.getQuotedMessage();
        const contact = await quotedMsg.getContact();
        const userId = contact.id.user;
        bot.admins.add(userId);
        bot.saveAdmins();
        if (bot.users.has(userId)) {
            bot.users.get(userId).isAdmin = true;
            bot.saveUsers();
        }
        await message.reply(`◐ ${contact.pushname || contact.number} added as admin`);
        bot.log(`Admin added: ${userId}`);
    }
};