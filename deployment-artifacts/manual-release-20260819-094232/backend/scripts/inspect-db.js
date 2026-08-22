require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require('../src/config/db');

(async () => {
  const [d] = await pool.execute('SELECT id,domain,type,platform,is_enabled,is_primary FROM domains ORDER BY id');
  console.log('DOMAINS:', JSON.stringify(d, null, 1));
  const [c] = await pool.execute("SELECT config_key, LEFT(config_value, 40) AS v FROM system_configs WHERE config_key LIKE 'suolink%'");
  console.log('CONFIGS:', JSON.stringify(c));
  const [sl] = await pool.execute('SELECT domain_id, platform, COUNT(*) AS n FROM short_links GROUP BY domain_id, platform');
  console.log('LINKS:', JSON.stringify(sl));
  const [cols] = await pool.execute("SHOW COLUMNS FROM short_links LIKE 'created_by'");
  console.log('created_by col:', JSON.stringify(cols));
  const [u] = await pool.execute('SELECT id, phone, role, status, business_group_id FROM users');
  console.log('USERS:', JSON.stringify(u));
  const [g] = await pool.execute('SELECT id,name FROM business_groups');
  console.log('GROUPS:', JSON.stringify(g));
  const [t] = await pool.execute("SHOW TABLES LIKE 'business_group_visit_quotas'");
  console.log('quota table:', JSON.stringify(t));
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
