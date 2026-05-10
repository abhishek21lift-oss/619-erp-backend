const router = require('express').Router();

router.get('/', async (req, res) => {
  res.json({
    success: true,
    message: 'Checkin route working',
  });
});

module.exports = router;
