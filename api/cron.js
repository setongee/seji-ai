import { db } from '../lib/db.js'
import { sendMessage } from '../lib/whatsapp.js'

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const now = new Date()

  // Fetch all pending tasks with a remind_at in the past
  const snap = await db.collection('tasks')
    .where('status', '==', 'pending')
    .where('remind_at', '<=', now)
    .get()

  if (snap.empty) {
    return res.status(200).json({ fired: 0 })
  }

  const results = await Promise.allSettled(
    snap.docs.map(async (doc) => {
      const task = doc.data()

      const message = task.check_in
        ? `⏰ *Reminder:* ${task.title}\n\nAll done? Reply *YES* to mark complete or *SNOOZE* to push 1 hour.`
        : `⏰ *Reminder:* ${task.title}`

      await sendMessage(task.phone, message)

      await doc.ref.update({
        status: task.check_in ? 'awaiting_confirmation' : 'done'
      })
    })
  )

  const fired = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length

  console.log(`Cron: fired ${fired}, failed ${failed}`)
  return res.status(200).json({ fired, failed })
}
