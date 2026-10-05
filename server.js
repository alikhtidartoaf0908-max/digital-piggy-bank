const express = require('express');
const bodyParser = require('body-parser');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Secret key for Webhook authentication
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "MY_PIGGY_BANK_SECRET_123";

// Regex patterns for bKash and Nagad SMS
const BKASH_REGEX = /You have received Tk ([0-9]+(?:\.[0-9]+)?) from (01[0-9]{9}).*TrxID ([A-Z0-9]+)/i;
const NAGAD_REGEX = /Received Tk ([0-9]+(?:\.[0-9]+)?) from (01[0-9]{9}).*TxnID: ([A-Z0-9]+)/i;

// Webhook endpoint to receive incoming SMS
app.post('/api/webhook/sms', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized webhook secret' });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, message: 'No SMS message body' });
  }

  let match = message.match(BKASH_REGEX) || message.match(NAGAD_REGEX);

  if (!match) {
    return res.status(200).json({ success: true, message: 'SMS ignored (No match)' });
  }

  const amount = parseFloat(match[1]);
  const senderPhone = match[2];
  const trxId = match[3];

  // Match user by phone number
  db.get("SELECT * FROM users WHERE phone = ?", [senderPhone], (err, user) => {
    if (err || !user) {
      console.log(`Payment received from unregistered number: ${senderPhone}`);
      return res.status(200).json({ success: true, message: 'User not found for this phone' });
    }

    // Insert transaction and update balance atomically
    db.run(
      "INSERT INTO transactions (trx_id, user_id, amount, sender_phone) VALUES (?, ?, ?, ?)",
      [trxId, user.id, amount, senderPhone],
      function (txErr) {
        if (txErr) {
          console.log(`Duplicate TrxID or error: ${trxId}`);
          return res.status(200).json({ success: true, message: 'Transaction already processed' });
        }

        db.run(
          "UPDATE users SET balance = balance + ? WHERE id = ?",
          [amount, user.id],
          (updateErr) => {
            if (updateErr) console.error("Balance update failed:", updateErr);
            console.log(`Added ${amount} Tk to user ${user.username} (TrxID: ${trxId})`);
            return res.json({ success: true, message: 'Balance updated successfully' });
          }
        );
      }
    );
  });
});

// Withdrawal Request Endpoint (Minimum 105 Tk)
app.post('/api/withdraw', (req, res) => {
  const { userId, amount } = req.body;

  if (amount < 105) {
    return res.status(400).json({ success: false, message: 'Minimum withdrawal balance is 105 Taka' });
  }

  db.get("SELECT balance FROM users WHERE id = ?", [userId], (err, user) => {
    if (err || !user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.balance < amount) {
      return res.status(400).json({ success: false, message: 'Insufficient balance' });
    }

    // Deduct balance and record withdrawal request
    db.run("UPDATE users SET balance = balance - ? WHERE id = ?", [amount, userId], (upErr) => {
      if (upErr) return res.status(500).json({ success: false, message: 'Transaction failed' });

      db.run("INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)", [userId, amount], (wErr) => {
        res.json({ success: true, message: 'Withdrawal request placed successfully (100 Tk payout after 5 Tk fee)' });
      });
    });
  });
});

app.listen(PORT, () => console.log(`Piggy Bank server running on port ${PORT}`));
