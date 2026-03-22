const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const DATA_FILE = 'orders.json';

/* =========================
   LOAD + SAVE ORDERS
========================= */
function loadOrders() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveOrders(orders) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
}

let orders = loadOrders();

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
   HELPER: PLACE + MARK
========================= */
async function placeAndMark(run, config, label) {
  try {
    const result = await placeOrder({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      service: config.service,
      link: config.link,
      quantity: run.quantity,
    });

    if (result?.order) {
      console.log(`[${label}] SUCCESS`, result.order);
      run.done = true;
    } else {
      console.error(`[${label}] FAILED`, result);
    }
  } catch (err) {
    console.error(`[${label}] ERROR`, err.response?.data || err.message);
  }
}

/* =========================
   FIXED RUN-BASED EXECUTION
========================= */
async function processRunsByTime(order) {
  const { apiUrl, apiKey, link, services } = order;

  const totalRuns = Math.max(
    services.views?.runs.length || 0,
    services.likes?.runs.length || 0,
    services.shares?.runs.length || 0,
    services.saves?.runs.length || 0
  );

  for (let i = 0; i < totalRuns; i++) {

    console.log(`===== RUN ${i + 1} START =====`);

    // VIEWS
    if (
      services.views?.runs[i] &&
      Number(services.views.runs[i].quantity) > 0 &&
      !services.views.runs[i].done
    ) {
      await placeAndMark(services.views.runs[i], {
        apiUrl,
        apiKey,
        service: services.views.serviceId,
        link
      }, 'VIEWS');
    }

    // LIKES
    if (
      services.likes?.runs[i] &&
      Number(services.likes.runs[i].quantity) > 0 &&
      !services.likes.runs[i].done
    ) {
      await placeAndMark(services.likes.runs[i], {
        apiUrl,
        apiKey,
        service: services.likes.serviceId,
        link
      }, 'LIKES');
    }

    // SHARES (STRICT minimum 20)
    if (
      services.shares?.runs[i] &&
      Number(services.shares.runs[i].quantity) >= 20 &&
      !services.shares.runs[i].done
    ) {
      await placeAndMark(services.shares.runs[i], {
        apiUrl,
        apiKey,
        service: services.shares.serviceId,
        link
      }, 'SHARES');
    } else if (services.shares?.runs[i]) {
      console.log(`SHARES SKIPPED (below 20):`, services.shares.runs[i].quantity);
    }

    // SAVES (skip first run)
    if (
      i !== 0 &&
      services.saves?.runs[i] &&
      Number(services.saves.runs[i].quantity) > 0 &&
      !services.saves.runs[i].done
    ) {
      await placeAndMark(services.saves.runs[i], {
        apiUrl,
        apiKey,
        service: services.saves.serviceId,
        link
      }, 'SAVES');
    }

    saveOrders(orders);

    console.log(`===== RUN ${i + 1} DONE =====`);

    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}

/* =========================
   RESUME ORDERS
========================= */
function resumeOrders() {
  console.log('Resuming orders...');

  orders.forEach(order => {
    processRunsByTime(order);
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

  const order = {
    id: Date.now(),
    apiUrl,
    apiKey,
    link,
    services
  };

  Object.values(order.services).forEach(s => {
    s.runs.forEach(run => run.done = false);
  });

  orders.push(order);
  saveOrders(orders);

  console.log('Order created:', order.id);

  processRunsByTime(order);

  return res.json({
    success: true,
    message: 'Order scheduled safely',
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
  resumeOrders();
});
