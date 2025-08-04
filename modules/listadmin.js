module.exports = {
    name: 'listadmin',
    description: 'List all admins',
    adminOnly: true,
    hideFromList: false,
    execute: async (message, args, client, bot) => {
        let adminList = '◑ *Admin List:*\n\n';
        let count = 1;
        for (const adminId of bot.admins) {
            const user = bot.users.get(adminId);
            const name = user ? user.name : adminId;
            adminList += `${count}. ${name} (${adminId})\n`;
            count++;
        }
        adminList += `\n◐ Total Admins: ${bot.admins.size}`;
        await message.reply(adminList);
    }
};