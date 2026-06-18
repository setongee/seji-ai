import { db } from '../lib/db.js'
import { sendMessage, sendButtons } from '../lib/whatsapp.js'

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const now = new Date()
  let fired = 0
  let failed = 0

  // ──────────────────────────────────────────────
  // 1. SINGLE-POINT REMINDERS (remind_at tasks)
  // ──────────────────────────────────────────────
  try {
    const snap = await db.collection('tasks')
      .where('status', '==', 'pending')
      .where('remind_at', '<=', now)
      .get()

    await Promise.allSettled(
      snap.docs
        .filter(doc => !doc.data().starts_at)
        .map(async (doc) => {
          const task = doc.data()
          if (task.check_in) {
            await sendButtons(
              task.phone,
              `⏰ *${task.title}*\n\nTime's up — did you get this done?`,
              [
                { id: 'done', title: '✅ Done' },
                { id: 'snooze', title: '⏰ Snooze 1 hour' },
              ],
              null,
              'Tap a button or type DONE / SNOOZE'
            )
          } else {
            await sendMessage(task.phone, `⏰ *Reminder:* ${task.title}`)
          }
          await doc.ref.update({ status: task.check_in ? 'awaiting_confirmation' : 'done' })
          fired++
        })
    )
  } catch (err) {
    console.error('Single-point reminders error:', err)
    failed++
  }

  // ──────────────────────────────────────────────
  // 2. TIMED BLOCK TASKS — check-ins during work
  // ──────────────────────────────────────────────
  try {
    const timedSnap = await db.collection('tasks')
      .where('status', 'in', ['pending', 'active'])
      .get()

    const timedTasks = timedSnap.docs
      .map(doc => ({ id: doc.id, ref: doc.ref, ...doc.data() }))
      .filter(t => t.starts_at || t.ends_at)

    await Promise.allSettled(timedTasks.map(async (task) => {
      const phone = task.phone
      const starts = task.starts_at?.toDate()
      const ends = task.ends_at?.toDate()
      const updates = {}
      const nowMs = now.getTime()

      // ── Start notification ──
      if (starts && !task.start_notified && nowMs >= starts.getTime()) {
        const endStr = ends
          ? ` until *${ends.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}*`
          : ''
        await sendButtons(
          phone,
          `🟢 Time to start: *${task.title}*\n\nYou've got${endStr}. Head down, let's go 🔥`,
          [
            { id: 'started', title: "🚀 Let's go!" },
            { id: 'snooze_start', title: '⏰ Give me 5 mins' },
          ]
        )
        updates.start_notified = true
        updates.status = 'active'
        fired++
      }

      if (!starts || nowMs < starts.getTime()) return

      const elapsedMs = nowMs - starts.getTime()
      const elapsedMins = elapsedMs / 60000
      const remainingMs = ends ? ends.getTime() - nowMs : null
      const remainingMins = remainingMs ? remainingMs / 60000 : null

      // ── 30-minute check-in ──
      if (!task.checkin_30_sent && elapsedMins >= 30 && elapsedMins < 35) {
        const remaining = remainingMins ? `About *${Math.round(remainingMins)} mins* left.` : ''
        await sendButtons(
          phone,
          `💬 How's *${task.title}* going?\n\n${remaining} No pressure — just checking in 👊`,
          [
            { id: 'going_well', title: '💪 Going well' },
            { id: 'need_help', title: '😅 Bit stuck' },
          ]
        )
        updates.checkin_30_sent = true
        fired++
      }

      // ── 60-minute check-in ──
      if (!task.checkin_60_sent && elapsedMins >= 60 && elapsedMins < 65) {
        const remaining = remainingMins ? `Just *${Math.round(remainingMins)} mins* to go.` : ''
        await sendButtons(
          phone,
          `🙌 One full hour on *${task.title}*! Solid work.\n\n${remaining} One more lap 💪`,
          [
            { id: 'on_track', title: '✅ On track' },
            { id: 'extend_30', title: '⏰ Need more time' },
          ]
        )
        updates.checkin_60_sent = true
        fired++
      }

      // ── 5-minutes-before-end warning ──
      if (ends && !task.checkin_5min_sent && remainingMins !== null && remainingMins <= 5 && remainingMins > 0) {
        await sendButtons(
          phone,
          `⏳ 5 minutes left on *${task.title}*.\n\nPush through — finish strong! 🎯`,
          [
            { id: 'almost_done', title: '🏁 Almost done' },
            { id: 'extend_15', title: '+15 mins' },
          ]
        )
        updates.checkin_5min_sent = true
        fired++
      }

      // ── End of task ──
      if (ends && !task.end_notified && nowMs >= ends.getTime()) {
        await sendButtons(
          phone,
          `⏰ Time's up on *${task.title}*!\n\nHow did it go?`,
          [
            { id: 'done', title: '✅ Done' },
            { id: 'extend_30', title: '+30 mins' },
            { id: 'extend_60', title: '+60 mins' },
          ],
          null,
          'Tap a button or type DONE / EXTEND 30'
        )
        updates.end_notified = true
        updates.status = 'awaiting_confirmation'
        fired++
      }

      if (Object.keys(updates).length > 0) {
        await task.ref.update(updates)
      }
    }))
  } catch (err) {
    console.error('Timed tasks error:', err)
    failed++
  }

  // ──────────────────────────────────────────────
  // 3. DAILY DIGEST — 8am WAT
  // ──────────────────────────────────────────────
  try {
    const watHour = new Date(now.getTime() + 60 * 60 * 1000).getUTCHours()
    const watMin = now.getUTCMinutes()

    if (watHour === 8 && watMin < 1) {
      const tasksSnap = await db.collection('tasks')
        .where('status', 'in', ['pending', 'active'])
        .get()

      const byPhone = {}
      tasksSnap.docs.forEach(doc => {
        const t = doc.data()
        if (!byPhone[t.phone]) byPhone[t.phone] = []
        byPhone[t.phone].push(t)
      })

      await Promise.allSettled(
        Object.entries(byPhone).map(async ([phone, tasks]) => {
          const userDoc = await db.collection('users').doc(phone).get()
          const name = userDoc.exists ? userDoc.data().name : null
          const greeting = name ? `Morning ${name}! ☀️` : 'Morning! ☀️'

          const list = tasks
            .slice(0, 8)
            .map((t, i) => {
              let time = ''
              if (t.starts_at && t.ends_at) {
                const s = t.starts_at.toDate().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })
                const e = t.ends_at.toDate().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })
                time = ` (${s}–${e})`
              } else if (t.remind_at) {
                const r = t.remind_at.toDate().toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })
                time = ` (${r})`
              }
              return `${i + 1}. ${t.title}${time}`
            })
            .join('\n')

          await sendButtons(
            phone,
            `${greeting}\n\nHere's your day:\n\n${list}\n\nLet's make it count 💪`,
            [
              { id: 'ready', title: "🔥 Let's go!" },
              { id: 'show_tasks', title: '📋 Show details' },
            ]
          )
          fired++
        })
      )
    }
  } catch (err) {
    console.error('Daily digest error:', err)
    failed++
  }

  console.log(`Cron: fired ${fired}, failed ${failed}`)
  return res.status(200).json({ fired, failed })
}
