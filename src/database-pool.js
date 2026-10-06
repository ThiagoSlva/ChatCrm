'use strict';

// Keep mysql2's configured connection/queue bounds. Classify only acquisition
// refusal: an SQL failure after acquiring a connection may have changed data.
function boundedDatabasePool(pool) {
  async function getConnection() {
    try { return await pool.getConnection(); }
    catch (error) {
      if (error instanceof Error && error.message === 'Queue limit reached.' && !error.code && !error.sql) {
        const busy = new Error('Database waiting queue is full.');
        busy.statusCode = 429;
        busy.code = 'CL_DATABASE_BUSY';
        throw busy;
      }
      throw error;
    }
  }
  async function run(method, args) {
    const connection = await getConnection();
    try { return await connection[method](...args); }
    finally { connection.release(); }
  }
  return {
    getConnection,
    query: (...args) => run('query', args),
    execute: (...args) => run('execute', args),
    end: () => pool.end()
  };
}

module.exports = { boundedDatabasePool };
