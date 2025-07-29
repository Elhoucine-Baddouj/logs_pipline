const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { createClient } = require('@clickhouse/client');

const app = express();

// Middleware d'optimisation
app.use(compression()); // Compression gzip
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Cache en mémoire pour les requêtes fréquentes
const cache = new Map();
const CACHE_TTL = 30000; // 30 secondes

// Fonction pour nettoyer le cache
const cleanupCache = () => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      cache.delete(key);
    }
  }
};

// Nettoyer le cache toutes les 30 secondes
setInterval(cleanupCache, CACHE_TTL);

// Configuration ClickHouse optimisée
const clickhouse = createClient({
  host: 'http://172.20.121.14:8123',
  username: 'default',
  password: 'sancho07',
  database: 'logs',
  clickhouse_settings: {
    wait_end_of_query: 1,
    max_block_size: 10000,
    max_threads: 4,
    max_memory_usage: 2000000000, // 2GB
    max_bytes_before_external_group_by: 4000000000, // 4GB
    max_bytes_before_external_sort: 4000000000, // 4GB
    join_algorithm: 'hash',
    optimize_aggregation_in_order: 1,
    optimize_sorting_by_input_stream_properties: 1,
            use_uncompressed_cache: 1,
        max_compress_block_size: 1048576, // 1MB
  },
});

// Fonction utilitaire pour exécuter des requêtes avec cache
const executeQueryWithCache = async (query, cacheKey) => {
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }

  const result = await clickhouse.query({ query, format: 'JSON' }).then(r => r.json());
  
  cache.set(cacheKey, {
    data: result.data,
    timestamp: Date.now()
  });

  return result.data;
};

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
    const safeLimit = Math.min(parseInt(limit), 200);
    
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
    
    // Requête optimisée avec index
    const query = `
      SELECT 
        EventTime,
        Hostname,
        EventID,
        SourceName,
        Severity,
        Message,
        EventType,
        Keywords,
        SeverityValue,
        ProviderGuid,
        Version,
        Task,
        OpcodeValue,
        RecordNumber,
        ProcessID,
        ThreadID,
        Channel,
        Opcode,
        EventReceivedTime,
        SourceModuleName,
        SourceModuleType,
        host,
        port,
        source_type,
        timestamp,
        ActivityID,
        CallerProcessId,
        CallerProcessName,
        Category,
        SubjectDomainName,
        SubjectLogonId,
        SubjectUserName,
        SubjectUserSid,
        TargetDomainName,
        TargetSid,
        TargetUserName,
        raw_data
      FROM windows_events 
      ${whereClause} 
      ORDER BY EventTime DESC 
      LIMIT ${safeLimit} OFFSET ${offset}
    `;
    
    const cacheKey = `logs_${JSON.stringify(req.query)}`;
    const result = await executeQueryWithCache(query, cacheKey);
    
    res.json(result);
  } catch (err) {
    console.error('Logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /stats - Optimisé avec cache
app.get('/stats', async (req, res) => {
  try {
    const cacheKey = 'stats_all';
    
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    // Requêtes optimisées avec index
    const volumeQuery = `
      SELECT 
        toDate(EventTime) as event_date, 
        count() as count 
      FROM windows_events 
      GROUP BY toDate(EventTime) 
      ORDER BY event_date DESC 
      LIMIT 30
    `;
    
    const severityQuery = `
      SELECT 
        Severity, 
        count() as count 
      FROM windows_events 
      GROUP BY Severity 
      ORDER BY count DESC
    `;
    
    const sourceNameQuery = `
      SELECT 
        SourceName, 
        count() as count 
      FROM windows_events 
      GROUP BY SourceName 
      ORDER BY count DESC 
      LIMIT 10
    `;
    
    const eventTypeQuery = `
      SELECT 
        EventType, 
        count() as count 
      FROM windows_events 
      GROUP BY EventType 
      ORDER BY count DESC 
      LIMIT 10
    `;

    const [volume, severity, sourceName, eventType] = await Promise.all([
      clickhouse.query({ query: volumeQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: severityQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: sourceNameQuery, format: 'JSON' }).then(r => r.json()),
      clickhouse.query({ query: eventTypeQuery, format: 'JSON' }).then(r => r.json()),
    ]);
    
    // Formater les données de sévérité
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
    
    const result = {
      volume: volume.data,
      severity: formattedSeverity,
      sourceName: sourceName.data,
      eventType: eventType.data,
    };

    // Mettre en cache
    cache.set(cacheKey, {
      data: result,
      timestamp: Date.now()
    });

    res.json(result);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /test - Route de test optimisée
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

// GET /logs/count - Compter le nombre total de logs avec filtres (optimisé)
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
    
    const cacheKey = `count_${JSON.stringify(req.query)}`;
    const result = await executeQueryWithCache(query, cacheKey);
    
    res.json({ count: result[0].count });
  } catch (err) {
    console.error('Count error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /logs/all - Récupérer tous les logs (très optimisé)
app.get('/logs/all', async (req, res) => {
  try {
    console.log('Fetching all logs...');
    
    // Requête optimisée avec sélection de colonnes spécifiques
    const query = `
      SELECT 
        EventTime,
        Hostname,
        EventID,
        SourceName,
        Severity,
        Message,
        EventType,
        Keywords,
        SeverityValue,
        ProviderGuid,
        Version,
        Task,
        OpcodeValue,
        RecordNumber,
        ProcessID,
        ThreadID,
        Channel,
        Opcode,
        EventReceivedTime,
        SourceModuleName,
        SourceModuleType,
        host,
        port,
        source_type,
        timestamp,
        ActivityID,
        CallerProcessId,
        CallerProcessName,
        Category,
        SubjectDomainName,
        SubjectLogonId,
        SubjectUserName,
        SubjectUserSid,
        TargetDomainName,
        TargetSid,
        TargetUserName,
        raw_data
      FROM windows_events 
      ORDER BY EventTime DESC
    `;
    
    const result = await clickhouse.query({ 
      query, 
      format: 'JSON',
      clickhouse_settings: {
        max_block_size: 10000,
        max_threads: 4,
        max_memory_usage: 2000000000, // 2GB
        max_bytes_before_external_group_by: 4000000000, // 4GB
        max_bytes_before_external_sort: 4000000000, // 4GB
        join_algorithm: 'hash',
        optimize_aggregation_in_order: 1,
        optimize_sorting_by_input_stream_properties: 1,
        use_uncompressed_cache: 1,
        max_compress_block_size: 1048576, // 1MB
      }
    }).then(r => r.json());
    
    console.log(`Fetched ${result.data.length} logs`);
    res.json(result.data);
  } catch (err) {
    console.error('All logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Route pour obtenir les statistiques du cache
app.get('/cache-stats', (req, res) => {
  res.json({
    size: cache.size,
    keys: Array.from(cache.keys()),
    memoryUsage: process.memoryUsage()
  });
});

// Route pour vider le cache
app.post('/cache-clear', (req, res) => {
  cache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend API running on port ${PORT}`);
  console.log('Performance optimizations enabled:');
  console.log('- Compression enabled');
  console.log('- Cache enabled (30s TTL)');
  console.log('- ClickHouse optimizations enabled');
}); 