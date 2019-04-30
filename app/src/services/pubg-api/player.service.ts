import { CacheService, SqlPlayersService } from '../';
import { Player, PlayerSeason, PubgAPI } from '../../pubg-typescript-api';
import { IPlayer } from '../../interfaces';
import { TimeInSeconds } from '../../shared/constants';
import { PubgSeasonService } from './season.service';
import { PubgPlatformService } from './platform.service';

const cache = new CacheService();


export class PubgPlayerService {

    /**
     * Returns a pubg character id
     * @param {PubgAPI} api
     * @param {string} name
     * @returns {Promise<string>} a promise that resolves to a pubg id
     */
    static async getPlayerId(api: PubgAPI, name: string): Promise<string> {
        const platform: string = PubgPlatformService.getPlatformDisplayName(api.platformRegion);
        const player: IPlayer = await SqlPlayersService.getPlayer(name, platform);

        if (player && player.pubg_id && player.pubg_id !== '') {
            return player.pubg_id;
        } else {
            return await this.getPlayerIdByName(api, name);
        }
    }

    /**
     * Get player(s) by id
     * @param {PubgAPI} api
     * @param {string[]} ids
     * @returns {Promise<string>} a promise that resolves to a pubg id
     */
    static async getPlayersById(api: PubgAPI, ids: string[]): Promise<Player[]> {
        const cacheKey: string = `pubgApi.getPlayersById-${api.platformRegion}-${ids}`;
        const ttl: number = TimeInSeconds.FIFTHTEEN_MINUTES;
        const storeFunction: Function = async (): Promise<Player[]> => {
            return Player.filterById(api, ids).catch(() => []);
        };

        return await cache.get<Player[]>(cacheKey, storeFunction, ttl);
    }

    /**
     * Get player(s) by name
     * @param {PubgAPI} api
     * @param {string[]} names
     * @returns {Promise<Player[]>} list of player(s)
     */
    static async getPlayersByName(api: PubgAPI, names: string[]): Promise<Player[]> {
        const cacheKey: string = `pubgApi.getPlayersByName-${api.platformRegion}-${names}`;
        const ttl: number = TimeInSeconds.FIFTHTEEN_MINUTES;
        const storeFunction: Function = async (): Promise<Player[]> => {
            return Player.filterByName(api, names).catch(() => []);
        };

        return await cache.get<Player[]>(cacheKey, storeFunction, ttl);
    }

    /**
     * Get a player's id
     * @param {PubgAPI} api
     * @param {string[]} names
     * @returns {Promise<string>} a player's id
     */
    private static async getPlayerIdByName(api: PubgAPI, name: string): Promise<string>  {
        const cacheKey: string = `pubgApi.getPlayerIdByName-${name}-${api.platformRegion}`;
        const ttl: number = TimeInSeconds.ONE_MINUTE;
        const storeFunction: Function = async (): Promise<string> => {
            const result: Player[] = await this.getPlayersByName(api, [name]);

            if (result.length === 0) { return ''; }

            const player: Player = result[0];
            const platform: string = PubgPlatformService.getPlatformDisplayName(api.platformRegion);
            await SqlPlayersService.addPlayer(player.name, player.id, platform);
            return player.id;
        };

        return await cache.get<string>(cacheKey, storeFunction, ttl);
    }

    /**
     * Retreives a player's season stats for the specified season
     * @param {PubgAPI} api
     * @param {string} id
     * @param {string} season
     * @returns {Promise<PlayerSeason>}
     */
    static async getPlayerSeasonStatsById(api: PubgAPI, id: string, season: string): Promise<PlayerSeason> {
        const cacheKey: string = `pubgApi.getPlayerSeasonStatsById-${id}-${season}-${api.platformRegion}`;
        const ttl: number = TimeInSeconds.FIFTHTEEN_MINUTES;
        const storeFunction: Function = async (): Promise<PlayerSeason> => {
            const seasonId: string = PubgSeasonService.getPubgSeasonId(season);
            return PlayerSeason.get(api, id, seasonId).catch(() => null);
        };

        return await cache.get<PlayerSeason>(cacheKey, storeFunction, ttl);
    }

}
