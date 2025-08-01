module.exports = {
    name: 'removeadmin',
    description: 'Remove admin privileges (reply to message)',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (!message.hasQuotedMsg) {
            return await message.reply('◑ Reply to a message to remove admin');
        }
        const quotedMsg = await message.getQuotedMessage();
        const contact = await quotedMsg.getContact();
        const userId = contact.id.user;
        if (userId === client.info.wid.user) {
            return await message.reply('◑ Cannot remove bot owner admin');
        }
        bot.admins.delete(userId);
        bot.saveAdmins();
        if (bot.users.has(userId)) {
            bot.users.get(userId).isAdmin = false;
            bot.saveUsers();
        }
        await message.reply(`◐ ${contact.pushname || contact.number} admin removed`);
        bot.log(`Admin removed: ${userId}`);
    }
};