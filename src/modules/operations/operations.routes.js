const express = require('express');

const router = express.Router();
const store = new Map();

const statuses = ['Draft', 'Pending', 'Active', 'Approved', 'Completed'];
const priorities = ['Low', 'Medium', 'High', 'Urgent'];
const channels = ['Front desk', 'App', 'WhatsApp', 'Email', 'Trainer', 'Branch'];

function seed(moduleKey) {
  if (store.has(moduleKey)) return store.get(moduleKey);
  const owners = ['Aarav Sharma', 'Priya Nair', 'Rohan Mehta', 'Sneha Iyer', 'Karan Patel'];
  const records = Array.from({ length: 12 }).map((_, index) => {
    const due = new Date();
    due.setDate(due.getDate() + index - 3);
    return {
      id: `${moduleKey}-${index + 1}`,
      title: `${titleFromKey(moduleKey)} ${index + 1}`,
      owner: owners[index % owners.length],
      status: statuses[index % statuses.length],
      priority: priorities[(index + 1) % priorities.length],
      amount: 1200 + index * 650,
      dueDate: due.toISOString().slice(0, 10),
      channel: channels[(index + 2) % channels.length],
      notes: 'Mock API record ready for replacement with database persistence.',
      createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    };
  });
  store.set(moduleKey, records);
  return records;
}

function titleFromKey(moduleKey) {
  return moduleKey
    .replace(/^engagement-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function validate(body) {
  const required = ['title', 'owner', 'status', 'priority', 'dueDate', 'channel'];
  for (const field of required) {
    if (!String(body[field] || '').trim()) {
      const err = new Error(`${field} is required`);
      err.status = 400;
      throw err;
    }
  }
  if (Number(body.amount) < 0 || Number.isNaN(Number(body.amount))) {
    const err = new Error('amount must be zero or greater');
    err.status = 400;
    throw err;
  }
}

router.get('/:moduleKey', (req, res) => {
  res.json(seed(req.params.moduleKey));
});

router.post('/:moduleKey', (req, res, next) => {
  try {
    validate(req.body);
    const records = seed(req.params.moduleKey);
    const created = {
      id: `${req.params.moduleKey}-${Date.now()}`,
      title: String(req.body.title).trim(),
      owner: String(req.body.owner).trim(),
      status: String(req.body.status).trim(),
      priority: String(req.body.priority).trim(),
      amount: Number(req.body.amount || 0),
      dueDate: String(req.body.dueDate).slice(0, 10),
      channel: String(req.body.channel).trim(),
      notes: String(req.body.notes || '').trim(),
      createdAt: new Date().toISOString(),
    };
    records.unshift(created);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/:moduleKey/:id', (req, res, next) => {
  try {
    validate({ ...seed(req.params.moduleKey).find((record) => record.id === req.params.id), ...req.body });
    const records = seed(req.params.moduleKey);
    const index = records.findIndex((record) => record.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Record not found' });
    records[index] = {
      ...records[index],
      ...req.body,
      amount: Number(req.body.amount ?? records[index].amount),
      updatedAt: new Date().toISOString(),
    };
    res.json(records[index]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:moduleKey/:id', (req, res) => {
  const records = seed(req.params.moduleKey);
  const nextRecords = records.filter((record) => record.id !== req.params.id);
  store.set(req.params.moduleKey, nextRecords);
  res.json({ message: 'Record deleted' });
});

module.exports = router;

