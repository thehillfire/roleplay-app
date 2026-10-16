# Moderating Kindred

A playbook for whoever opens **Moderate** (at first, that's you). It covers what each screen shows, what to do with it, and the few situations where speed matters. It is not legal advice; the legal points at the end need a lawyer's confirmation.

## Your daily pass (10–20 minutes)

1. **Dashboard numbers.** Look at *Held to review*, *Support requests open* and open reports. Those are your queue.
2. **Reports** (oldest first). Read the transcript, decide, move on.
3. **Held.** Clear it. Every item is either a real problem or a false positive.
4. **Appeals.** Answer within a day; a paused person can't use the app until you do.
5. **Inbox.** Reply or close. Replies are emailed only to confirmed addresses (it says so if not).

Urgent items also arrive by email: possible minors (including a new signup from a browser where an under-18 signup was just refused), people at risk, possible ban evasion. Those can't wait for the daily pass.

## Held messages

The screener holds a message before delivery and tells the sender why. Each held message shows up to three messages from just before it, which is usually enough to tell a parent talking about their kid from someone fishing. Suspending from here asks first, because it bans their devices too. Labels you'll see:

| Label | What it caught | Usual call |
| --- | --- | --- |
| Contact info | Phone, email, socials, links, or *asking* for them | **Keep held.** Contact is only allowed after both connect. |
| Asked location | "Where do you live", "what city" | Keep held. |
| Meetup or photos | "Wanna meet up?", "send me a selfie" | Keep held. A repeat offender trying several strangers: suspend. |
| Asked age | "How old are you", "asl" | Keep held. Repeated age questions plus flirting is a grooming pattern: look them up. |
| Maybe under 18 | "16f", "I'm fifteen", a bare "tengo 15" | **Read the whole chat.** Clearly a minor: suspend. Clearly not (talking about their kid): *Deliver anyway*. |
| Said under 18 | "I'm 15 years old", "I'm in 10th grade" | The account is already paused. Confirm it or restore it. |
| Sexual / Sexual + minors | Solicitation; anything sexual involving minors | Keep held; suspend for solicitation. **Sexual + minors: see "Child safety" below.** |
| Hate / Harassment / Threat | Slurs, "kys", threats | Keep held. Suspend for anything aimed at the other person. |
| Copy-paste spam | Same long text to 3+ people in an hour | Keep held, suspend. |

Use **Deliver anyway** generously for real false positives. Every wrongly held message silences someone who came to talk. When one turns up, add it to `server/test/fixtures/venting.txt` so the rules get fixed (the test suite fails until they are).

## Reports

- **Dismiss**: nothing wrong (disagreements, bad vibes, someone being blunt).
- **Warn**: borderline. It's logged, and the person sees a one-line reminder of the guidelines next time they open the app.
- **Suspend**: clear abuse, sexual messages to a stranger, hate, repeated contact-fishing, minors. Their devices are banned too, so a new account from the same browser starts paused.

Whatever you decide, the reporter sees "Thanks for your report. A moderator has reviewed it." (never the outcome).

The transcript includes unsent messages ("unsent by sender") on purpose: abusers send and unsend.

Auto-pauses (3 reporters in a week, or 2 for "under 18") are not verdicts. Review them like reports, and restore people who were brigaded.

## Someone at risk

The app already shows the person 988 and findahelpline.com (with Spanish instructions) and gives the listener guidance. You are not a crisis service and shouldn't act like one. But:
- A report for **"worried about their safety"** emails you right away. Read it the same day.
- If a message shows **imminent danger with identifying details** (rare, since the app strips contact info), contacting emergency services is a judgment call. Write down what you did and why.
- Never message the person from your own accounts. Don't promise anything.

## Child safety

Kindred is 18+, and the birthdate check is self-reported. Minors will get in.
- **Possible minor:** suspend. Don't argue age with them. If they're an adult, they can appeal.
- **An adult pursuing someone who seems to be a minor** (age questions, then flirting, asking for photos or to meet): suspend immediately and keep the evidence (reports and held messages stay for 90 days after deletion).
- **Sexual content involving a minor:** this is the one situation with legal duties (see below). Don't delete anything. Suspend the account and get advice the same day.

## Appeals

Read the note, check the account in **Look up** (open reports, held messages, past actions), then decide. *Restore* when the pause was a mistake or a first, minor slip. Most appeals after a "said under 18" pause come from adults who were joking. Restore them, but note it.

You can add a short note (500 characters) with either answer. The person sees it on their paused screen, so write it to them: what happened and what would change your mind, never who reported them. After a *Keep paused*, they can send a new note a week later, so one "no" isn't permanent.

## Look up

When someone writes in about a handle ("QuietHeron42 harassed me"), use **Look up**. It shows status, reports against and by them, held messages and every action taken, but never the email. Moderators don't need emails; keep it that way.

## Legal points to confirm with a lawyer

- [Likely] US online services that become aware of apparent child sexual abuse material must report it to the NCMEC CyberTipline (18 U.S.C. § 2258A). Kindred has no images, which lowers the risk but doesn't remove it. Ask about text-only grooming evidence too.
- [Likely] Keep a short written record of serious decisions (who, what, why). The audit log covers the "what"; add the "why" in the action detail or your own notes.
- [Guessing] Law enforcement requests: decide in advance who answers them and what you'll require (a subpoena or warrant). Kindred stores email, birthdate, messages and hashed device ids.

## When it's too much for one person

Plan for a second moderator before about 500 daily users (see LAUNCH.md). Give them a confirmed email listed in `ADMIN_EMAILS`. Everything they do is in the log.
