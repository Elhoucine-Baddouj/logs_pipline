const express = require('express');
const cors = require('cors');
const { createClient } = require('@clickhouse/client');

const app = express();
app.use(cors());
app.use(express.json());

const clickhouse = createClient({
  host: 'http://172.20.121.14:8123',
  username: 'default',
  password: 'sancho07',
  database: 'logs',
  clickhouse_settings: {
    wait_end_of_query: 1,
  },
});

// GET /logs?search=&severity=&hostname=&sourceName=&eventType=&from=&to=&page=&limit=
app.get('/logs', async (req, res) => {
  try {
    const {
      search = '',
      severity = '',
      hostname = '',
      sourceName = '',
      eventType = '',
      from = '',
      to = '',
      page = 1,
      limit = 50,
    } = req.query;
    
    // Limiter la taille maximale pour éviter les surcharges
    const safeLimit = Math.min(parseInt(limit), 100);
    
    let where = [];
    if (search) where.push(`Message LIKE '%${search.replace(/'/g, "''")}%'`);
    if (severity) where.push(`Severity = '${severity.replace(/'/g, "''")}'`);
    if (hostname) where.push(`Hostname = '${hostname.replace(/'/g, "''")}'`);
    if (sourceName) where.push(`SourceName = '${sourceName.replace(/'/g, "''")}'`);
    if (eventType) where.push(`EventType = '${eventType.replace(/'/g, "''")}'`);
    if (from) where.push(`EventTime >= '${from}'`);
    if (to) where.push(`EventTime <= '${to}'`);
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * safeLimit;
    const query = `SELECT * FROM windows_events ${whereClause} ORDER BY EventTime DESC LIMIT ${safeLimit} OFFSET ${offset}`;
    console.log('Executing query:', query);
    const result = await clickhouse.query({ query, format: 'JSON' }).then(r => r.json());
    console.log('Query result:', result);
    res.json(result.data);
  } catch (err) {
    console.error('Logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /stats
app.get('/stats', async (req, res) => {
  try {
    const volumeQuery = `SELECT toDate(EventTime) as event_date, count() as count FROM windows_events GROUP BY toDate(EventTime) ORDER BY event_date DESC LIMIT 30`;
    const severityQuery = `SELECT Severity, count() as count FROM windows_events GROUP BY Severity ORDER BY count DESC`;
    const sourceNameQuery = `SELECT SourceName, count() as count FROM windows_events GROUP BY SourceName ORDER BY count DESC LIMIT 10`;
    const eventTypeQuery = `SELECT EventType, count() as count FROM windows_events GROUP BY EventType ORDER BY count DESC LIMIT 10`;
    const [volume, severity, sourceName, eventType] = await Promise.all([
      clickhouse.query({ query: volumeQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: severityQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: sourceNameQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: eventTypeQuery, format: 'JSON' }).then(r => r.json()),
    ]);
    
    console.log('Severity data:', severity);
    console.log('Severity data length:', severity.data ? severity.data.length : 'no data');
    
    // S'assurer que les données de sévérité ont le bon format et convertir les counts en nombres
    const formattedSeverity = severity.data && severity.data.length > 0 
      ? severity.data.map(item => ({
          ...item,
          count: parseInt(item.count) || 0
        }))
      : [
        { Severity: 'ERROR', count: 0 },
        { Severity: 'WARNING', count: 0 },
        { Severity: 'INFO', count: 0 },
        { Severity: 'DEBUG', count: 0 }
      ];
    
    console.log('Formatted severity:', formattedSeverity);

    res.json({
      volume: volume.data,
      severity: formattedSeverity,
      sourceName: sourceName.data,
      eventType: eventType.data,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /test - Route de test pour diagnostiquer
app.get('/test', async (req, res) => {
  try {
    console.log('Testing ClickHouse connection...');
    const result = await clickhouse.query({ 
      query: 'SELECT EventTime, Hostname, EventID, Message FROM windows_events LIMIT 1', 
      format: 'JSON' 
    }).then(r => r.json());
    console.log('Test result:', result);
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('Test error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET /test-severity - Route de test pour diagnostiquer les valeurs de sévérité
app.get('/test-severity', async (req, res) => {
  try {
    console.log('Testing severity values...');
    const result = await clickhouse.query({ 
      query: 'SELECT DISTINCT Severity, count() as count FROM windows_events GROUP BY Severity ORDER BY count DESC', 
      format: 'JSON' 
    }).then(r => r.json());
    console.log('Severity test result:', result);
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('Severity test error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET /logs/count - Compter le nombre total de logs avec filtres
app.get('/logs/count', async (req, res) => {
  try {
    const {
      search = '',
      severity = '',
      hostname = '',
      sourceName = '',
      eventType = '',
      from = '',
      to = '',
    } = req.query;
    let where = [];
    if (search) where.push(`Message LIKE '%${search.replace(/'/g, "''")}%'`);
    if (severity) where.push(`Severity = '${severity.replace(/'/g, "''")}'`);
    if (hostname) where.push(`Hostname = '${hostname.replace(/'/g, "''")}'`);
    if (sourceName) where.push(`SourceName = '${sourceName.replace(/'/g, "''")}'`);
    if (eventType) where.push(`EventType = '${eventType.replace(/'/g, "''")}'`);
    if (from) where.push(`EventTime >= '${from}'`);
    if (to) where.push(`EventTime <= '${to}'`);
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const query = `SELECT count() as count FROM windows_events ${whereClause}`;
    console.log('Count query:', query);
    const result = await clickhouse.query({ query, format: 'JSON' }).then(r => r.json());
    res.json({ count: result.data[0].count });
  } catch (err) {
    console.error('Count error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /logs/all - Récupérer tous les logs (optimisé pour les performances)
app.get('/logs/all', async (req, res) => {
  try {
    console.log('Fetching all logs...');
    const query = `SELECT * FROM windows_events ORDER BY EventTime DESC`;
    const result = await clickhouse.query({ 
      query, 
      format: 'JSON',
      clickhouse_settings: {
        max_block_size: 5000,
        max_threads: 2,
        max_memory_usage: 1000000000, // 1GB
        max_bytes_before_external_group_by: 2000000000, // 2GB
        max_bytes_before_external_sort: 2000000000, // 2GB
        join_algorithm: 'hash',
        optimize_aggregation_in_order: 1,
        optimize_sorting_by_input_stream_properties: 1,
      }
    }).then(r => r.json());
    console.log(`Fetched ${result.data.length} logs`);
    res.json(result.data);
  } catch (err) {
    console.error('All logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend API running on port ${PORT}`);
}); 