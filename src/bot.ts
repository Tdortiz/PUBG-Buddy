import * as Discord from 'discord.js';
import DBClient = require("dblapi.js");
import * as fs from 'fs';
import { join } from 'path';
import {
    AnalyticsService,
    CommonService,
    SqlServerService
 } from './services';
import { Command, DiscordClientWrapper } from './entities';
import { IServer } from './interfaces'
import * as Commands from './cmd';
import * as logger from './config/logger.config';

export class Bot {

    private botUserId: string = CommonService.getEnvironmentVariable('bot_user_id');
    private prefix: string = CommonService.getEnvironmentVariable('prefix');
    private bot: DiscordClientWrapper;
    private discordBotsClient: DBClient;

    constructor() {
        this.bot = new DiscordClientWrapper();
        const discordBotsApiToken: string = CommonService.getEnvironmentVariable('discord_bots_api_key');
        this.discordBotsClient = new DBClient(discordBotsApiToken, this.bot);

        this.setupListeners();
        this.registerCommands();
    }

    public start = async () => {
        const botToken: string = CommonService.getEnvironmentVariable('bot_token');
        await this.bot.login(botToken);
    }

    public restart = async () => {
        await this.bot.destroy();
        this.bot = new DiscordClientWrapper();
        await this.start();
    }

    private setupListeners = () => {
        this.bot.on('unhandledRejection', (error: any) => { logger.error(`Uncaught Promise Rejection:\n${error}`); });
        this.bot.on('error', logger.error);
        this.bot.on('warn', logger.warn);
        this.bot.on('guildCreate', this.onGuildCreate);
        this.bot.on('guildDelete', this.onGuildDelete);
        this.bot.on('ready', this.onReady);
        this.bot.on('message', this.onMessage);
        this.bot.reload = this.onReload;
        this.bot.elevation = this.elevation;
    }

    /**
     * Registers the commands in the src/cmd folder
     */
    private registerCommands = () => {
        this.bot.commands = new Discord.Collection();
        this.bot.aliases = new Discord.Collection();

        const isDirectory = (source: string) => fs.lstatSync(source).isDirectory();
        const getDirectories = (source: string) => fs.readdirSync(source).map(name => join(source, name)).filter(isDirectory);
        const dirs: string[] = getDirectories('./src/cmd/');

        // Loop through cmd/<cmd-type> folders to grab commands
        dirs.forEach((folder: string) => {
            fs.readdir(folder, (err: NodeJS.ErrnoException, files: string[]) => {
                if (err) { logger.error(err.message); }

                files.forEach((f: string) => {
                    const fileName: string = f.split('.')[0];
                    const uppercaseName: string = fileName.charAt(0).toUpperCase() + fileName.slice(1);
                    const command: Command = new Commands[uppercaseName] as Command;
                    logger.info(`Loading Command: ${command.help.name}.`);
                    this.bot.commands.set(command.help.name, command);
                    command.conf.aliases.forEach(alias => {
                        this.bot.aliases.set(alias, command.help.name);
                    });
                });
            });
        });
    }

    private onReady = () => {
        logger.info(`Bot has started, with ${this.bot.users.size} users, in ${this.bot.channels.size} channels of ${this.bot.guilds.size} guilds.`);

        const isDev: boolean = CommonService.getEnvironmentVariable('isDev') === 'true';
        if (!isDev) {
            logger.info('Updating discord bots stats');
            this.discordBotsClient.postStats(this.bot.guilds.size).catch(() => { logger.error('Failed to update discord bots'); });
            setInterval(() => {
                logger.info('Updating discord bots stats');
                this.discordBotsClient.postStats(this.bot.guilds.size).catch(() => { logger.error('Failed to update discord bots'); });
            }, 1800000);
        }

        const alertChannelId: string = CommonService.getEnvironmentVariable('alert_channel_id');
        (this.bot.channels.find(i => i.id === alertChannelId) as Discord.TextChannel).send(`**${this.bot.user.username}** is back online.`);

        this.bot.user.setActivity("Use `!pubg-help`");
    }

    private onMessage = async (msg: Discord.Message) => {
        // Ignore this bot's messages
        if (msg.author.id === this.botUserId) { return; }

        // Ignore other bots
        //if (msg.author.bot) return;

        let isGuildMessage: boolean = false;
        let perms: number = 0;

        // Grab relevant guild info if not DM
        let customPrefix: string = '';
        if (msg.guild) {
            isGuildMessage = true;
            let server_defaults: IServer = await SqlServerService.getServer(msg.guild.id);

            if (!server_defaults.isStoredInDb) {
                SqlServerService.deleteServerCache(msg.guild.id);
            }

            customPrefix = server_defaults.default_bot_prefix.toLowerCase();
            perms = this.bot.elevation(msg);
        }

        // Ignore requests without our prefix/customPrefix
        let command: string;
        if (msg.content.toLowerCase().startsWith(this.prefix)) {
            command = msg.content.split(' ')[0].slice(this.prefix.length);
        } else if (msg.content.toLowerCase().startsWith(customPrefix)) {
            command = msg.content.split(' ')[0].slice(customPrefix.length);
        } else {
            return;
        }

        let params: string[] = [];
        try {
            params = this.getParams(msg.content);
        }  catch (e) {
            msg.channel.send(e, { code: 'asciidoc' });
            return;
        }

        // Get command
        let cmd: Command | null = this.getCommand(command);

        // Run command
        if (cmd && this.checkIfCommandIsRunnable(msg, cmd, isGuildMessage, perms)) {
            AnalyticsService.setPerson(msg.author.id, {});
            cmd.run(this.bot, msg, params, perms);
        }
    }

    private onGuildCreate = (guild: Discord.Guild) => {
        SqlServerService.registerServer(guild.id).then(() => {
            logger.info(`New guild joined: ${guild.name} (id: ${guild.id}). This guild has ${guild.memberCount} members!`);
            AnalyticsService.track('New Discord server', {
                guildName: guild.name,
                guildId: guild.id,
                memberCount: guild.memberCount
            });
        });
    }

    private onGuildDelete = (guild: Discord.Guild) => {
        SqlServerService.unRegisterServer(guild.id).then(() => {
            AnalyticsService.track('Removed Discord server', {
                guildName: guild.name,
                guildId: guild.id,
                memberCount: guild.memberCount
            });
            logger.info(`Removed ${guild.name} from database.`);
        });
    }

    private onReload = (command: any): Promise<any> => {
        return new Promise((resolve, reject) => {
            try {
                delete require.cache[require.resolve(`./cmd/${command}`)];
                const cmd: Command = require(`./cmd/${command}`);
                this.bot.commands.delete(command);

                this.bot.aliases.forEach((cmd: any, alias) => {
                    if (cmd === command) { this.bot.aliases.delete(alias); }
                });

                this.bot.commands.set(command, cmd);
                cmd.conf.aliases.forEach(alias => {
                    this.bot.aliases.set(alias, cmd.help.name);
                });
                resolve();
            } catch (e){
                reject(e);
            }
        });
    }

    private getParams = (content: string): string[] => {
        const params: string[] = content.split(' ').slice(1);
        const retParams: string[] = [];

        for (let i = 0; i < params.length; i++) {
            let s: string = params[i];

            if (s.startsWith('\"') && i < s.length) {
                // find ending quote
                let foundEndingQuote: boolean = false;

                for (let j = i; j < params.length; j++) {
                    let s2: string = params[j];

                    if (j === i && s2.lastIndexOf('\"') === s2.length-1) {
                        foundEndingQuote = true;
                        break;
                    }

                    if (j === i) { continue; }

                    if (s2.lastIndexOf('\"') === s2.length-1) {
                        params.splice(j, 1);
                        s += ` ${s2}`;
                        foundEndingQuote = true;
                        break;
                    } else {
                        params.splice(j, 1);
                        j--
                        s += ` ${s2}`;
                    }
                }

                if (!foundEndingQuote) {
                    throw 'Error:: Must specify both quotes when using quotes parameters.';
                }

                // clean up quotations
                s = s.substring(1, s.length-1);
            }
            retParams.push(s);
        }

        return retParams;
    }

    /**
     * Given a command name, return the bot's command object
     * @param {string} command
     * @returns {} command object
     */
    private getCommand = (command: string): Command | null => {
        if (this.bot.commands.has(command)) {
            return this.bot.commands.get(command);
        } else if (this.bot.aliases.has(command)) {
            return this.bot.commands.get(this.bot.aliases.get(command));
        }
        return null;
    }

    /**
     * Checks if a command is runnable by a user
     * @param {Discord.Message} msg
     * @param {any} cmd
     * @param {boolean} isGuildMessage
     * @param {any} perms
     * @returns {boolean} true if runnable, false otherwise
     */
    private checkIfCommandIsRunnable = (msg: Discord.Message, cmd: any, isGuildMessage: boolean, perms: any): boolean => {
        // Check if cmd is enabled
        if (!cmd.conf.enabled) return false;
        // Check if valid context to run command
        if (!isGuildMessage && cmd.conf.guildOnly) {
            msg.channel.send('Guild only command');
            return false;
        }
        // Check permissions
        //logger.info('user_perms = ' + perms + '; cmd_permission = ' + cmd.conf.permLevel);
        if (perms < cmd.conf.permLevel) {
            msg.channel.send('Invalid permissions');
            return false;
        }
        return true;
    }

    /**
     * Resolves an elevation level used by the command handler for verification
     * @returns {number} permission level
     */
    private elevation = (msg: Discord.Message): number => {
        let permlvl: number = 0;

        const hasAdminPermissions: boolean = msg.member ? msg.member.hasPermission('ADMINISTRATOR'): false;
        if (hasAdminPermissions) { permlvl = 4; }

        return permlvl;
    }

}
