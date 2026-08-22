const mysql = require('mysql2/promise');

// 连接池会在首次执行 SQL 时建立实际连接。
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  // DATETIME 字段统一按 UTC 读写。生产数据库通常以 UTC 运行；如果让
  // mysql2 按服务器本地时区解析，返回浏览器后会再次偏移 8 小时。
  timezone: 'Z',
});

// NOW()/CURRENT_TIMESTAMP 也固定为 UTC，避免数据库主机、Node 进程和
// 浏览器分别使用不同时区时生成时间发生偏移。
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'");
});

module.exports = pool;
