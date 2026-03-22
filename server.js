const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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
   EXECUTE RUN (NEW FUNCTION)
========================= */
async function executeRun(run, config, label, index) {
  try {
    console.log(`[${label}] Executing run ${index + 1}`, run);

    if (!run.quantity || run.quantity <= 0) {
      console.log(`[${label}] Skipped (quantity 0)`);
      return;
    }

    const result = await placeOrder({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      service: config.service,
      link: config.link,
      quantity: run.quantity,
    });

    if (result?.order) {
      console.log(`[${label}] SUCCESS`, result.order);
    } else {
      console.error(`[${label}] FAILED`, result);
    }

  } catch (err) {
    console.error(`[${label}] ERROR`, err.response?.data || err.message);
  }
}

/* =========================
   SCHEDULE SINGLE RUN
========================= */
function scheduleRun(run, config, label, index) {
  const runTime = new Date(run.time).getTime();
  const now = Date.now();

  const delay = runTime - now;

  // ✅ FIX: run immediately if past
  if (delay <= 0) {
    console.log(`[${label}] Run ${index + 1} time passed → executing now`);
    executeRun(run, config, label, index);
    return;
  }

  console.log(`[${label}] Scheduling run ${index + 1} in ${delay} ms`);

  setTimeout(() => {
    executeRun(run, config, label, index);
  }, delay);
}

/* =========================
   PROCESS ALL RUNS
========================= */
function processRuns(services, baseConfig) {
  Object.entries(services).forEach(([key, serviceConfig]) => {
    if (!serviceConfig) return;

    const label = key.toUpperCase();

    serviceConfig.runs.forEach((run, index) => {
      scheduleRun(
        run,
        {
          apiUrl: baseConfig.apiUrl,
          apiKey: baseConfig.apiKey,
          service: serviceConfig.serviceId,
          link: baseConfig.link,
        },
        label,
        index
      );
    });
  });
}

/* =========================
   CREATE ORDER
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, link, services } = req.body;

  if (!apiUrl || !apiKey || !link || !services) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('Received order with real-time scheduling');

  processRuns(services, { apiUrl, apiKey, link });

  return res.json({
    success: true,
    message: 'Order scheduled with real-time execution',
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
});
