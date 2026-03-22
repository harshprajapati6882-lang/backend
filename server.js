const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

/* =========================
   HELPER: PLACE ORDER
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
   PROCESS RUNS (PER SERVICE)
========================= */
async function processRuns(runs, config, label) {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    console.log(`[${label}] Run ${i + 1}`, run);

    try {
      const result = await placeOrder({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        service: config.service,
        link: config.link,
        quantity: run.quantity,
      });

      if (result?.order) {
        console.log(`[${label}] SUCCESS:`, result.order);
      } else if (result?.error) {
        console.error(`[${label}] FAILED:`, result.error);
      } else if (result?.status === 'fail') {
        console.error(`[${label}] FAILED:`, result.message);
      } else {
        console.error(`[${label}] UNKNOWN:`, result);
      }

    } catch (err) {
      console.error(`[${label}] ERROR:`, err.response?.data || err.message);
    }

    // wait before next run
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

/* =========================
   CREATE ORDER (MULTI SERVICE)
========================= */
app.post('/api/order', async (req, res) => {
  const { apiUrl, apiKey, link, services } = req.body;

  if (!apiUrl || !apiKey || !link || !services) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  console.log('Received multi-service order');

  // Process each service independently
  if (services.views) {
    processRuns(services.views.runs, {
      apiUrl,
      apiKey,
      service: services.views.serviceId,
      link,
    }, 'VIEWS');
  }

  if (services.likes) {
    processRuns(services.likes.runs, {
      apiUrl,
      apiKey,
      service: services.likes.serviceId,
      link,
    }, 'LIKES');
  }

  if (services.shares) {
    processRuns(services.shares.runs, {
      apiUrl,
      apiKey,
      service: services.shares.serviceId,
      link,
    }, 'SHARES');
  }

  if (services.saves) {
    processRuns(services.saves.runs, {
      apiUrl,
      apiKey,
      service: services.saves.serviceId,
      link,
    }, 'SAVES');
  }

  return res.json({
    success: true,
    message: 'Multi-service order scheduled',
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
