const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DATA_FILE = 'runs.json';

/* =========================
   LOAD + SAVE RUNS
========================= */
function loadRuns() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveRuns(runs) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(runs, null, 2));
}

let allRuns = loadRuns();

/* =========================
   PLACE ORDER
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
      allRuns.push({
        id: Date.now() + Math.random(),
        schedulerOrderId,
        label,
        apiUrl: baseConfig.apiUrl,
        apiKey: baseConfig.apiKey,
        service: serviceConfig.serviceId,
        link: baseConfig.link,
        quantity: run.quantity,
        time: run.time,
        done: false,
        cancelled: false,
        paused: false,
        retryCount: 0,
        isExecuting: false,
      });
    });
  });

  saveRuns(allRuns);
}

/* =========================
   EXECUTE RUN (SAFE + RETRY)
========================= */
async function executeRun(run) {
  // 🔥 CRITICAL FIX: Check cancellation FIRST
  if (run.cancelled) {
    if (!run.done) {
      run.done = true;
      console.log(`[SAFEGUARD] Cancelled run marked as done: ${run.label} (ID: ${run.id})`);
      saveRuns(allRuns);
    }
    return;
  }

  // Skip if already done, executing, or paused
  if (run.done || run.isExecuting || run.paused) return;

  run.isExecuting = true;

  try {
    if (!run.quantity || run.quantity <= 0) {
      run.isExecuting = false;
      return;
    }

    console.log(`[${run.label}] Executing`, run);

    const result = await placeOrder(run);

    // 🔥 Check if cancelled during execution
    if (run.cancelled || run.paused) {
      console.log(`[${run.label}] Stopped (cancelled/paused)`);
      if (run.cancelled) {
        run.done = true;
        saveRuns(allRuns);
      }
      run.isExecuting = false;
      return;
    }

    if (result?.order) {
      console.log(`[${run.label}] SUCCESS`, result.order);
      run.done = true;
    } else {
      console.error(`[${run.label}] FAILED`, result);

      if (run.retryCount < 3 && !run.cancelled && !run.paused) {
        run.retryCount++;
        console.log(`[${run.label}] Retrying in 60 sec... Attempt ${run.retryCount}`);

        setTimeout(() => executeRun(run), 60000);
      } else {
        console.error(`[${run.label}] Max retries reached`);
        run.done = true;
      }
    }

  } catch (err) {
    console.error(`[${run.label}] ERROR`, err.response?.data || err.message);

    if (run.retryCount < 3 && !run.cancelled && !run.paused) {
      run.retryCount++;
      console.log(`[${run.label}] Retrying after error... Attempt ${run.retryCount}`);

      setTimeout(() => executeRun(run), 60000);
    } else {
      console.error(`[${run.label}] Max retries reached after error`);
      run.done = true;
    }
  }

  run.isExecuting = false;
}

/* =========================
   MAIN SCHEDULER
========================= */
setInterval(async () => {
  const now = Date.now();

  for (let run of allRuns) {
    // 🔥 FIX: Mark cancelled runs as done to stop re-checking
    if (run.cancelled) {
      if (!run.done) {
        run.done = true;
        console.log(`[CLEANUP] Marked cancelled run as done: ${run.label} (ID: ${run.id})`);
      }
      continue;
    }

    // Skip completed or paused runs
    if (run.done || run.paused) continue;
    
    const runTime = new Date(run.time).getTime();

    if (runTime <= now) {
      await executeRun(run);
    }
  }

  saveRuns(allRuns);

}, 10000);

/* =========================
   CREATE ORDER
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, link, services, name } = req.body;

  if (!apiUrl || !apiKey || !link || !services) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const schedulerOrderId = generateSchedulerOrderId();

  console.log(`Creating order with schedulerOrderId: ${schedulerOrderId}`);

  addRuns(services, { apiUrl, apiKey, link }, schedulerOrderId);

  return res.json({
    success: true,
    message: 'Order scheduled successfully',
    schedulerOrderId,
  });
});

/* =========================
   🔥 ORDER CONTROL (PAUSE/RESUME/CANCEL)
========================= */
app.post('/api/order/control', (req, res) => {
  const { schedulerOrderId, action } = req.body;

  console.log(`[Order Control] Received: ${action} for ${schedulerOrderId}`);
  console.log(`[Order Control] Current allRuns count: ${allRuns.length}`);

  if (!schedulerOrderId || !action) {
    return res.status(400).json({ 
      success: false,
      error: 'Missing schedulerOrderId or action' 
    });
  }

  if (!['pause', 'resume', 'cancel'].includes(action)) {
    return res.status(400).json({ 
      success: false,
      error: 'Invalid action. Must be pause, resume, or cancel' 
    });
  }

  // Find all runs for this schedulerOrderId
  const orderRuns = allRuns.filter(run => run.schedulerOrderId === schedulerOrderId);

  console.log(`[Order Control] Found ${orderRuns.length} runs for ${schedulerOrderId}`);

  if (orderRuns.length === 0) {
    console.warn(`[Order Control] No runs found for ${schedulerOrderId}`);
    console.log(`[Order Control] Sample schedulerOrderIds in storage:`, 
      [...new Set(allRuns.slice(0, 5).map(r => r.schedulerOrderId))]);
    
    return res.status(404).json({ 
      success: false,
      error: 'Order not found' 
    });
  }

  let affectedCount = 0;

  orderRuns.forEach(run => {
    if (action === 'cancel') {
      // 🔥 CRITICAL FIX: Mark as BOTH cancelled AND done
      if (!run.cancelled || !run.done) {
        const wasPending = !run.done && !run.cancelled;
        
        run.cancelled = true;
        run.done = true; // ✅ THIS IS THE KEY FIX
        run.paused = false;
        run.isExecuting = false;
        
        if (wasPending) {
          affectedCount++;
          console.log(`[Order Control] ✅ Cancelled run: ${run.label} @ ${run.time} (ID: ${run.id})`);
        }
      }
    } else if (action === 'pause') {
      if (!run.done && !run.cancelled) {
        run.paused = true;
        affectedCount++;
        console.log(`[Order Control] ⏸️ Paused run: ${run.label} (ID: ${run.id})`);
      }
    } else if (action === 'resume') {
      if (!run.done && !run.cancelled && run.paused) {
        run.paused = false;
        affectedCount++;
        console.log(`[Order Control] ▶️ Resumed run: ${run.label} (ID: ${run.id})`);
      }
    }
  });

  // 🔥 CRITICAL: Save immediately after modification
  saveRuns(allRuns);
  console.log(`[Order Control] ✅ Saved ${allRuns.length} runs to disk`);

  // Calculate final stats
  const completedRuns = orderRuns.filter(r => r.done && !r.cancelled).length;
  const cancelledRuns = orderRuns.filter(r => r.cancelled).length;
  const pausedRuns = orderRuns.filter(r => r.paused && !r.done && !r.cancelled).length;
  const pendingRuns = orderRuns.filter(r => !r.done && !r.cancelled && !r.paused).length;
  const totalRuns = orderRuns.length;

  let status = 'running';
  if (cancelledRuns === totalRuns) {
    status = 'cancelled';
  } else if (completedRuns === totalRuns) {
    status = 'completed';
  } else if (pausedRuns > 0 && pendingRuns === 0) {
    status = 'paused';
  }

  const runStatuses = orderRuns.map(run => {
    if (run.cancelled) return 'cancelled';
    if (run.done) return 'completed';
    return 'pending';
  });

  console.log(`[Order Control] ✅ ${action.toUpperCase()} completed:`, {
    affectedRuns: affectedCount,
    status,
    completedRuns,
    cancelledRuns,
    pausedRuns,
    pendingRuns,
    totalRuns
  });

  return res.json({
    success: true,
    status,
    completedRuns,
    totalRuns,
    affectedRuns: affectedCount,
    runStatuses,
  });
});

/* =========================
   LEGACY CANCEL ENDPOINT (Keep for backward compatibility)
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
      run.done = true; // 🔥 FIX: Mark as done
      cancelledCount++;
    }
  });

  saveRuns(allRuns);

  console.log(`Cancelled ${cancelledCount} runs for link: ${link}`);

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

  const completedRuns = orderRuns.filter(r => r.done).length;
  const cancelledRuns = orderRuns.filter(r => r.cancelled).length;
  const pausedRuns = orderRuns.filter(r => r.paused).length;
  const totalRuns = orderRuns.length;

  let status = 'running';
  if (cancelledRuns === totalRuns) status = 'cancelled';
  else if (completedRuns === totalRuns) status = 'completed';
  else if (pausedRuns > 0) status = 'paused';

  return res.json({
    schedulerOrderId,
    status,
    totalRuns,
    completedRuns,
    cancelledRuns,
    pausedRuns,
    runs: orderRuns.map(r => ({
      id: r.id,
      label: r.label,
      quantity: r.quantity,
      time: r.time,
      done: r.done,
      cancelled: r.cancelled,
      paused: r.paused,
    })),
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
    });

    return res.json(response.data);
  } catch (error) {
    return res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Loaded ${allRuns.length} existing runs from storage`);
});

/* =========================
   KEEP SERVER ALIVE
========================= */
setInterval(async () => {
  try {
    await axios.get("https://backend-y30y.onrender.com");
    console.log("Self-ping to keep server alive");
  } catch (e) {}
}, 5 * 60 * 1000);
