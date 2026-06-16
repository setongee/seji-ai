# WhatsApp AI Productivity Assistant

A personal AI assistant that lives on WhatsApp. Send it tasks, rants, or reminders in plain English — it extracts structured tasks, replies with an action plan, and fires reminders at the right time.

## Project structure

```
api/
  webhook.js    ← receives all incoming WhatsApp messages
  cron.js       ← runs every minute, fires due reminders
lib/
  ai.js         ← Claude integration, task extraction
  whatsapp.js   ← sends messages via Meta Cloud API
  db.js         ← Firebase Firestore client
vercel.json     ← cron schedule config
```

## Deploy steps

### 1. Set up Firebase
1. Go to console.firebase.google.com → Create a project (free Spark plan)
2. In your project → Project Settings → Service Accounts → click "Generate new private key"
3. Download the JSON — you'll copy 3 values from it: project_id, client_email, private_key

### 2. Create Firestore database
1. In Firebase Console → Build → Firestore Database → Create database
2. Choose "Start in production mode" → pick any region close to you → Done
3. Go to Firestore → Rules → replace with this and publish:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} {
         allow read, write: if false; // only server-side admin SDK can access
       }
     }
   }
   ```

### 3. Deploy to Vercel
1. Push this project to a GitHub repo
2. Go to vercel.com → New Project → import your repo
3. Go to Settings → Environment Variables → add all vars from .env.example
4. For FIREBASE_PRIVATE_KEY: paste the full key including the quotes and \n characters exactly as they appear in the downloaded JSON
5. Deploy — Vercel gives you a URL like https://your-app.vercel.app

### 4. Connect Meta webhook
1. Go to Meta developer dashboard → your app → WhatsApp → Configuration
2. Webhook URL: https://your-app.vercel.app/api/webhook
3. Verify token: whatever you set as WEBHOOK_VERIFY_TOKEN
4. Click Verify and Save → subscribe to the messages field

### 5. Test it
Send a WhatsApp message to your Meta test number. You should get a reply within a few seconds.

## Example messages it handles

- "Remind me at 3pm to review the Figma file"
- "I have a meeting at 4, remind me 10 mins before"
- "I'm overwhelmed — I need to finish the dashboard, send the invoice, and prep for tomorrow's call"
- "Add task: follow up with Akin by EOD"
- "In 20 minutes remind me to take a break"

## Replying to reminders

When a reminder fires, reply:
- **YES** or **DONE** → marks the task complete
- **SNOOZE** → pushes the reminder 1 hour forward
