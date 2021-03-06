import { CommonService } from '../services';
import { Pool } from 'pg';
import * as logger from './logger.config';


const connectionString: string = CommonService.getEnvironmentVariable('DATABASE_URL');
const pool: Pool = new Pool({ connectionString: connectionString, ssl: true });
pool.on('error', (err) => {
    logger.error('Unexpected error on idle client', err);
    process.exit(-1);
});

export = pool
