const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DATA_FILE = 'runs.json';

// 🔥 Retry configuration
const RETRY_DELAY_MINUTES = 5; // Retry every 5 minutes
const MAX_RETRY_HOURS = 2; // Max 2 hours from original time

// 🔥 Error patterns that indicate "order in progress" (add more as needed)
const CONFLICT_ERROR_PATTERNS = [
  'order already in progress',
  'order in progress',
  'already processing',
  'pending order',
  'duplicate order',
  'please wait',
  'too many orders',
  'rate limit',
  'try again later',
  'order exists',
  'already exists',
  'in queue',
  'processing',
];

/* =========================
   LOAD + SAVE RUNS
========================= */
function loadRuns() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE));
    // Reset isExecuting on load (in case server crashed mid-execution)
    return data.map(run => ({
      ...run,
      isExecuting: false
    }));
  } catch (err) {
    console.error('[Load Runs] Error parsing runs.json:', err.message);
    return [];
  }
}

function saveRuns(runs) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(runs, null, 2));
  } catch (err) {
    console.error('[Save Runs] Error saving runs.json:', err.message);
  }
}

let allRuns = loadRuns();
console.log(`[Startup] Loaded ${allRuns.length} runs from storage`);

// Track runs currently being executed to prevent duplicates
const executingRunIds = new Set();

/* =========================
   CHECK IF ERROR IS CONFLICT
========================= */
function isConflictError(errorMessage) {
  if (!errorMessage) return false;
  const lowerError = String(errorMessage).toLowerCase();
  return CONFLICT_ERROR_PATTERNS.some(pattern => lowerError.includes(pattern));
}

/* =========================
   CHECK IF RUN TIMED OUT
========================= */
function isRunTimedOut(run) {
  if (!run.originalTime) return false;
  const originalTime = new Date(run.originalTime).getTime();
  const maxTime = originalTime + (MAX_RETRY_HOURS * 60 * 60 * 1000);
  return Date.now() > maxTime;
}

/* =========================
   PLACE ORDER (API CALL)
========================= */
async function placeOrder({ apiUrl, apiKey, service, link, quantity }) {
  const params = new URLSearchParams({
    key: apiKey,
    action: 'add',
    service: String(service),
    link: String(link),
    quantity: String(quantity),
  });

  const response = await axios.post(apiUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });

  return response.data;
}

/* =========================
   GENERATE SCHEDULER ORDER ID
========================= */
function generateSchedulerOrderId() {
  return `SCH-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/* =========================
   ADD RUNS TO STORAGE
========================= */
function addRuns(services, baseConfig, schedulerOrderId) {
  Object.entries(services).forEach(([key, serviceConfig]) => {
    if (!serviceConfig) return;

    const label = key.toUpperCase();

    serviceConfig.runs.forEach((run) => {
      const runTime = run.time;
      allRuns.push({
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        schedulerOrderId,
        label,
        apiUrl: baseConfig.apiUrl,
        apiKey: baseConfig.apiKey,
        service: serviceConfig.serviceId,
        link: baseConfig.link,
        quantity: run.quantity,
        // 🔥 Time tracking
        originalTime: runTime, // Never changes
        time: runTime, // Current scheduled time (may be rescheduled)
        // Status flags
        done: false,
        cancelled: false,
        paused: false,
        isExecuting: false,
        // 🔥 Retry tracking
        retryCount: 0,
        retryReason: null,
        lastError: null,
        // Execution tracking
        executedAt: null,
        smmOrderId: null,
        createdAt: new Date().toISOString(),
      });
    });
  });

  saveRuns(allRuns);
}

/* =========================
   HANDLE RETRY / RESCHEDULE
========================= */
function handleRunRetry(run, errorMessage) {
  const isConflict = isConflictError(errorMessage);
  const isTimedOut = isRunTimedOut(run);

  run.lastError = errorMessage;

  // Check if we've exceeded max retry time
  if (isTimedOut) {
    console.log(`[${run.label}] ⏰ TIMEOUT - Exceeded ${MAX_RETRY_HOURS} hours from original time`);
    run.done = true;
    run.retryReason = `Timeout: Exceeded ${MAX_RETRY_HOURS}h retry limit`;
    return;
  }

  if (isConflict) {
    // 🔥 CONFLICT ERROR: Reschedule without counting as failure
    run.retryCount++;
    run.retryReason = 'Order in progress - waiting for previous order to complete';
    
    // Reschedule for RETRY_DELAY_MINUTES later
    const newTime = new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString();
    run.time = newTime;
    
    console.log(`[${run.label}] 🔄 CONFLICT - Rescheduled to ${newTime} (Retry #${run.retryCount})`);
  } else {
    // 🔥 OTHER ERROR: Count as failure, max 3 retries
    run.retryCount++;
    run.retryReason = `API Error: ${errorMessage}`;
    
    if (run.retryCount >= 3) {
      console.log(`[${run.label}] ❌ FAILED - Max retries (3) reached`);
      run.done = true;
    } else {
      // Reschedule for 2 minutes later (shorter for non-conflict errors)
      const newTime = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      run.time = newTime;
      console.log(`[${run.label}] 🔄 ERROR - Retry ${run.retryCount}/3 scheduled for ${newTime}`);
    }
  }
}

/* =========================
   EXECUTE SINGLE RUN
========================= */
async function executeRun(run) {
  const runId = run.id;

  // Check if already being executed
  if (executingRunIds.has(runId)) {
    return;
  }

  // Check cancelled/done/paused
  if (run.cancelled) {
    run.done = true;
    return;
  }

  if (run.done || run.paused) {
    return;
  }

  // Check timeout before executing
  if (isRunTimedOut(run)) {
    run.done = true;
    run.retryReason = `Timeout: Exceeded ${MAX_RETRY_HOURS}h retry limit`;
    console.log(`[${run.label}] ⏰ TIMEOUT before execution`);
    return;
  }

  // Mark as executing
  executingRunIds.add(runId);
  run.isExecuting = true;

  try {
    if (!run.quantity || run.quantity <= 0) {
      console.log(`[${run.label}] Skipping - invalid quantity: ${run.quantity}`);
      run.done = true;
      return;
    }

    console.log(`[${run.label}] ▶️ Executing: ${run.quantity} to ${run.link.slice(-20)} (Retry: ${run.retryCount})`);

    const result = await placeOrder(run);

    // Check if cancelled during execution
    if (run.cancelled) {
      console.log(`[${run.label}] Cancelled during execution`);
      run.done = true;
      return;
    }

    if (result?.order) {
      // 🔥 SUCCESS
      console.log(`[${run.label}] ✅ SUCCESS - SMM Order ID: ${result.order}`);
      run.done = true;
      run.executedAt = new Date().toISOString();
      run.smmOrderId = result.order;
      run.lastError = null;
      run.retryReason = null;
    } else if (result?.error) {
      // 🔥 API returned error
      console.error(`[${run.label}] ❌ API Error:`, result.error);
      handleRunRetry(run, result.error);
    } else {
      // 🔥 Unknown response
      console.error(`[${run.label}] ❌ Unknown response:`, JSON.stringify(result));
      handleRunRetry(run, 'Unknown API response');
    }

  } catch (err) {
    const errorMsg = err.response?.data?.error || err.response?.data?.message || err.message || 'Unknown error';
    console.error(`[${run.label}] ❌ EXCEPTION:`, errorMsg);
    handleRunRetry(run, errorMsg);
  } finally {
    // Always clean up
    run.isExecuting = false;
    executingRunIds.delete(runId);
    saveRuns(allRuns);
  }
}

/* =========================
   MAIN SCHEDULER
========================= */
let isSchedulerRunning = false;

async function runScheduler() {
  if (isSchedulerRunning) {
    return;
  }

  isSchedulerRunning = true;
  const now = Date.now();
  const pendingRuns = [];

  try {
    // Collect all runs that need to execute
    for (const run of allRuns) {
      // Clean up cancelled runs
      if (run.cancelled && !run.done) {
        run.done = true;
        continue;
      }

      // Skip if not eligible
      if (run.done || run.cancelled || run.paused || run.isExecuting) {
        continue;
      }

      if (executingRunIds.has(run.id)) {
        continue;
      }

      const runTime = new Date(run.time).getTime();

      if (runTime <= now) {
        pendingRuns.push(run);
      }
    }

    // Execute runs in parallel with concurrency limit
    const CONCURRENCY_LIMIT = 5;
    
    if (pendingRuns.length > 0) {
      console.log(`[Scheduler] Processing ${pendingRuns.length} pending runs...`);
      
      for (let i = 0; i < pendingRuns.length; i += CONCURRENCY_LIMIT) {
        const batch = pendingRuns.slice(i, i + CONCURRENCY_LIMIT);
        
        await Promise.all(batch.map(run => executeRun(run).catch(err => {
          console.error(`[Scheduler] Run execution error:`, err.message);
        })));
      }
    }

    saveRuns(allRuns);

    // Log stats occasionally
    if (pendingRuns.length > 0 || Math.random() < 0.05) {
      const stats = {
        total: allRuns.length,
        pending: allRuns.filter(r => !r.done && !r.cancelled && !r.paused).length,
        retrying: allRuns.filter(r => !r.done && !r.cancelled && r.retryCount > 0).length,
        done: allRuns.filter(r => r.done && !r.cancelled).length,
        cancelled: allRuns.filter(r => r.cancelled).length,
      };
      console.log(`[Scheduler] Stats:`, stats);
    }

  } catch (err) {
    console.error('[Scheduler] Error:', err.message);
  } finally {
    isSchedulerRunning = false;
  }
}

// Run scheduler every 10 seconds
setInterval(runScheduler, 10000);

// Run immediately on startup
setTimeout(runScheduler, 3000);

/* =========================
   CREATE ORDER
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, link, services, name } = req.body;

  if (!apiUrl || !apiKey || !link || !services) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const schedulerOrderId = generateSchedulerOrderId();

  console.log(`[Create Order] New order: ${schedulerOrderId}`);
  console.log(`[Create Order] Link: ${link}`);

  addRuns(services, { apiUrl, apiKey, link }, schedulerOrderId);

  const runsAdded = allRuns.filter(r => r.schedulerOrderId === schedulerOrderId).length;
  console.log(`[Create Order] ✅ Added ${runsAdded} runs`);

  return res.json({
    success: true,
    message: 'Order scheduled successfully',
    schedulerOrderId,
    runsAdded,
  });
});

/* =========================
   ORDER CONTROL
========================= */
app.post('/api/order/control', (req, res) => {
  const { schedulerOrderId, action } = req.body;

  console.log(`[Order Control] ${action?.toUpperCase()} for ${schedulerOrderId}`);

  if (!schedulerOrderId || !action) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing schedulerOrderId or action' 
    });
  }

  if (!['pause', 'resume', 'cancel'].includes(action)) {
    return res.status(400).json({ 
      success: false,
      error: 'Invalid action' 
    });
  }

  const orderRuns = allRuns.filter(run => run.schedulerOrderId === schedulerOrderId);

  if (orderRuns.length === 0) {
    return res.status(404).json({ 
      success: false,
      error: 'Order not found' 
    });
  }

  let affectedCount = 0;

  orderRuns.forEach(run => {
    if (action === 'cancel') {
      if (!run.done || !run.cancelled) {
        run.cancelled = true;
        run.done = true;
        run.paused = false;
        run.isExecuting = false;
        executingRunIds.delete(run.id);
        affectedCount++;
      }
    } else if (action === 'pause') {
      if (!run.done && !run.cancelled) {
        run.paused = true;
        affectedCount++;
      }
    } else if (action === 'resume') {
      if (!run.done && !run.cancelled && run.paused) {
        run.paused = false;
        affectedCount++;
      }
    }
  });

  saveRuns(allRuns);

  const stats = {
    total: orderRuns.length,
    completed: orderRuns.filter(r => r.done && !r.cancelled).length,
    cancelled: orderRuns.filter(r => r.cancelled).length,
    paused: orderRuns.filter(r => r.paused && !r.done).length,
    pending: orderRuns.filter(r => !r.done && !r.cancelled && !r.paused).length,
    retrying: orderRuns.filter(r => !r.done && !r.cancelled && r.retryCount > 0).length,
  };

  let status = 'running';
  if (stats.cancelled === stats.total) status = 'cancelled';
  else if (stats.completed === stats.total) status = 'completed';
  else if (stats.paused > 0 && stats.pending === 0) status = 'paused';

  console.log(`[Order Control] ✅ ${action}: ${affectedCount} runs affected`, stats);

  return res.json({
    success: true,
    status,
    ...stats,
    affectedRuns: affectedCount,
    runStatuses: orderRuns.map(r => {
      if (r.cancelled) return 'cancelled';
      if (r.done) return 'completed';
      if (r.retryCount > 0) return 'retrying';
      return 'pending';
    }),
  });
});

/* =========================
   🔥 GET ORDER RUNS (for frontend sync)
========================= */
app.get('/api/order/runs/:schedulerOrderId', (req, res) => {
  const { schedulerOrderId } = req.params;

  const orderRuns = allRuns.filter(run => run.schedulerOrderId === schedulerOrderId);

  if (orderRuns.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  return res.json({
    schedulerOrderId,
    runs: orderRuns.map(r => ({
      id: r.id,
      label: r.label,
      quantity: r.quantity,
      originalTime: r.originalTime,
      currentTime: r.time,
      done: r.done,
      cancelled: r.cancelled,
      paused: r.paused,
      isExecuting: r.isExecuting,
      retryCount: r.retryCount,
      retryReason: r.retryReason,
      lastError: r.lastError,
      executedAt: r.executedAt,
      smmOrderId: r.smmOrderId,
    })),
  });
});

/* =========================
   LEGACY CANCEL ENDPOINT
========================= */
app.post('/api/cancel', (req, res) => {
  const { link } = req.body;

  if (!link) {
    return res.status(400).json({ error: 'Missing link' });
  }

  let cancelledCount = 0;

  allRuns.forEach(run => {
    if (run.link === link && !run.done) {
      run.cancelled = true;
      run.done = true;
      executingRunIds.delete(run.id);
      cancelledCount++;
    }
  });

  saveRuns(allRuns);

  return res.json({
    success: true,
    cancelledRuns: cancelledCount,
  });
});

/* =========================
   GET ORDER STATUS
========================= */
app.get('/api/order/status/:schedulerOrderId', (req, res) => {
  const { schedulerOrderId } = req.params;

  const orderRuns = allRuns.filter(run => run.schedulerOrderId === schedulerOrderId);

  if (orderRuns.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const stats = {
    total: orderRuns.length,
    completed: orderRuns.filter(r => r.done && !r.cancelled).length,
    cancelled: orderRuns.filter(r => r.cancelled).length,
    paused: orderRuns.filter(r => r.paused).length,
    pending: orderRuns.filter(r => !r.done && !r.cancelled && !r.paused).length,
    retrying: orderRuns.filter(r => !r.done && !r.cancelled && r.retryCount > 0).length,
    executing: orderRuns.filter(r => r.isExecuting).length,
  };

  let status = 'running';
  if (stats.cancelled === stats.total) status = 'cancelled';
  else if (stats.completed === stats.total) status = 'completed';
  else if (stats.paused > 0 && stats.pending === 0) status = 'paused';

  return res.json({
    schedulerOrderId,
    status,
    ...stats,
    runs: orderRuns.map(r => ({
      id: r.id,
      label: r.label,
      quantity: r.quantity,
      originalTime: r.originalTime,
      currentTime: r.time,
      done: r.done,
      cancelled: r.cancelled,
      paused: r.paused,
      isExecuting: r.isExecuting,
      retryCount: r.retryCount,
      retryReason: r.retryReason,
      lastError: r.lastError,
      executedAt: r.executedAt,
    })),
  });
});

/* =========================
   DEBUG: View All Runs
========================= */
app.get('/api/debug/runs', (req, res) => {
  const stats = {
    total: allRuns.length,
    pending: allRuns.filter(r => !r.done && !r.cancelled && !r.paused).length,
    retrying: allRuns.filter(r => !r.done && !r.cancelled && r.retryCount > 0).length,
    executing: allRuns.filter(r => r.isExecuting).length,
    done: allRuns.filter(r => r.done && !r.cancelled).length,
    cancelled: allRuns.filter(r => r.cancelled).length,
    paused: allRuns.filter(r => r.paused).length,
    withErrors: allRuns.filter(r => r.lastError).length,
  };

  const pendingRuns = allRuns
    .filter(r => !r.done && !r.cancelled && !r.paused)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .slice(0, 20)
    .map(r => ({
      id: r.id,
      schedulerOrderId: r.schedulerOrderId,
      label: r.label,
      quantity: r.quantity,
      originalTime: r.originalTime,
      currentTime: r.time,
      isExecuting: r.isExecuting,
      retryCount: r.retryCount,
      retryReason: r.retryReason,
      lastError: r.lastError,
    }));

  return res.json({
    stats,
    pendingRuns,
    executingIds: Array.from(executingRunIds),
  });
});

/* =========================
   DEBUG: Force Retry Stuck Runs
========================= */
app.post('/api/debug/retry-stuck', (req, res) => {
  let fixedCount = 0;

  allRuns.forEach(run => {
    if (run.isExecuting && !executingRunIds.has(run.id)) {
      run.isExecuting = false;
      fixedCount++;
    }

    const runTime = new Date(run.time).getTime();
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    if (!run.done && !run.cancelled && !run.paused && runTime < oneHourAgo && !isRunTimedOut(run)) {
      run.time = new Date().toISOString();
      run.isExecuting = false;
      fixedCount++;
      console.log(`[Debug] Rescheduled stuck run: ${run.id}`);
    }
  });

  saveRuns(allRuns);

  return res.json({
    success: true,
    fixedRuns: fixedCount,
  });
});

/* =========================
   FETCH SERVICES
========================= */
app.post('/api/services', async (req, res) => {
  const { apiUrl, apiKey } = req.body;

  if (!apiUrl || !apiKey) {
    return res.status(400).json({ error: 'Missing API URL or key' });
  }

  try {
    const params = new URLSearchParams({
      key: apiKey,
      action: 'services',
    });

    const response = await axios.post(apiUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    return res.json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});

/* =========================
   HEALTH CHECK
========================= */
app.get('/api/health', (req, res) => {
  return res.json({
    status: 'ok',
    uptime: process.uptime(),
    totalRuns: allRuns.length,
    pendingRuns: allRuns.filter(r => !r.done && !r.cancelled && !r.paused).length,
    retryingRuns: allRuns.filter(r => !r.done && !r.cancelled && r.retryCount > 0).length,
    executingNow: executingRunIds.size,
  });
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Loaded ${allRuns.length} existing runs`);
  
  const pending = allRuns.filter(r => !r.done && !r.cancelled && !r.paused).length;
  const retrying = allRuns.filter(r => !r.done && r.retryCount > 0).length;
  console.log(`⏳ ${pending} runs pending, ${retrying} retrying`);
});

/* =========================
   KEEP SERVER ALIVE
========================= */
setInterval(async () => {
  try {
    await axios.get("https://backend-y30y.onrender.com/api/health");
    console.log("[Keep Alive] ✅");
  } catch (e) {}
}, 5 * 60 * 1000);
