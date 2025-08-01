module.exports = {
    name: 'ban',
    description: 'Ban a user (reply to message)',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        if (!message.hasQuotedMsg) {
            return await message.reply('◑ Reply to a message to ban user');
        }
        const quotedMsg = await message.getQuotedMessage();
        const contact = await quotedMsg.getContact();
        const userId = contact.id.user;
        if (userId === client.info.wid.user) {
            return await message.reply('◑ Cannot ban bot owner');
        }
        bot.bannedUsers.add(userId);
        bot.saveBannedUsers();
        await message.reply(`◐ ${contact.pushname || contact.number} has been banned`);
        bot.log(`User banned: ${userId}`);
    }
};