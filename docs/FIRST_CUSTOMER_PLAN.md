# Getting the first paying customer

Written 2026-11-06. The goal is one stranger-to-the-code person paying $12 a month because zWork
did a real job for them. Nothing can promise that. What this plan does is remove the reasons a
first sale fails: the person never hears of zWork, can't install it, doesn't see it work on their
own files, or is never asked to pay.

Most of it is done by a person, not by the product. That's the point. A founder sitting with
someone for twenty minutes beats every landing page, and zWork's weakest moments (the unsigned
installer, the first job) are exactly the ones a person can walk someone through.

**Keep names out of this repo.** It's public. The list of people goes in a private sheet.

## The offer

> Send me your most annoying monthly paperwork job. I'll sit with you for 20 minutes and set
> zWork up to do it on your own computer. If it works, it's $12 a month, and that price is yours
> for as long as you keep it. If it hasn't saved you an hour in the first month, tell me and I'll
> refund you.

- **One job to lead with: "read every PDF invoice in this folder into one spreadsheet."** It uses
  local files, needs no connector, and the result can be checked line by line. The spreadsheet
  checker refuses to deliver a workbook with broken formulas. Fall back to the other five jobs on
  the home screen when the person has a different problem.
- **Ask if their PDFs are scans before the call.** On 2026-11-06 this job passed from a fresh
  install three times out of three with hand-made PDFs: right numbers in a real Excel file, a saved
  schedule, a new invoice picked up on the next run, and a plain note about a PDF it couldn't read.
  Real scans and phone photos depend on OCR, which hasn't been tested. Neither have messy real
  invoices, so check every line on the first call.
- **Don't lead with Outlook, QuickBooks or Xero.** Those tiles need setup on Composio and a cloud
  deploy, and they haven't been tested end to end.
- **Don't discount.** $12 is already the price. A first customer on a 100% coupon proves nothing.
  Promo codes already work at checkout if one is ever needed.
- **The refund is a personal promise, made by you, by hand in Stripe.** `legal/TERMS.md` says fees
  are non-refundable, so don't put this on the website until you decide to change that sentence.

## Who to ask

Someone who pays for their own tools, does the same paperwork every month, and already trusts you
enough to take a call. In order:

1. **People you know.** Write down 30: anyone running a small business, freelancing, keeping the
   books for a family business, or working as an office manager or assistant. Include parents'
   friends, former bosses, your landlord, your dentist's office manager.
2. **Introductions.** Ask those same people who they know that drowns in invoices or expense
   reports. An introduction from a friend is worth ten cold messages.
3. **Free users who already saved a schedule.** They have shown intent. See "Before the first ask".
4. **Local groups.** Chamber of commerce, coworking spaces, small business meetups, town Facebook
   groups. Offer to help with one job, in person if possible.
5. **r/smallbusiness and r/freelance, last.** Answer people's questions for a while first and say
   you built zWork whenever you mention it. Don't post in r/Bookkeeping: its moderators treat new
   tools as self-promotion. Skip Upwork pitches too, since taking people off the platform breaks
   its rules, but read the job posts for how people describe this work.

## Before the first ask

Do these in order. Only you can do them.

1. **Ship the build.** v0.6.0 is what people download, and it has none of the recent work: the
   two-question onboarding, the six jobs, asking before connector actions, checked spreadsheets,
   open at login. This means a PR into `main`, a tag, and `scripts/check-version-sync.py`.
2. **Buy Pro yourself with a real card.** Sign in on a fresh account, pay $12, confirm the app
   flips to Pro, cancel, refund yourself. Checkout has never been proven with real money in this
   work, and the first customer must not be the test.
3. **Do the lead job on a clean machine.** Use a second computer or a new macOS user. Download
   from the website, install, sign in, run the invoice job on ten real PDFs, including a scan,
   then time it. First-time setup runs in the background and the job waits for it, so note how
   long that takes on a normal connection. Fix whatever breaks. You'll also see the Gatekeeper and SmartScreen warnings the customer will see.
4. **Decide on signing.** Installers are unsigned, so macOS and Windows both warn. On a call you
   can talk someone past it, so it doesn't block step 1 of "Who to ask". It does block everything
   sent to people who don't know you. Apple is $99 a year and Azure Trusted Signing about $10 a
   month. Buy them before contacting anyone in group 4 or 5.
5. **Make a booking link.** A free Cal.com or Calendly page with one 20-minute slot type. Keep a
   reply-to address you read daily. The website has no way to reach a human right now, so add the
   link to it too.
6. **Pull the warm list.** Query production for free users with a saved schedule or several runs
   in the last 30 days. Keep any note to them personal, one at a time, and about their use of the
   product. `legal/PRIVACY.md` doesn't mention marketing email, so no bulk send.

Allow two days for this.

## The messages

Write them in your own voice. These are starting points. Short is the rule.

**Someone you know**

> Hey [name], random question. I built a thing that does monthly paperwork on your own computer,
> like pulling a folder of invoices into a spreadsheet. Is there a job like that you hate? I'd
> like to try it on your real files for 20 minutes. Free to try, and I'll learn a lot.

**Asking for an introduction**

> Who do you know who spends hours a month on invoices or expense reports? I'm looking for two or
> three people to help set up for free this week, and I'll buy the coffee.

**A free user**

> Hi [name], I'm [you], I made zWork. I saw you set up a schedule. How's it going? If anything
> isn't working I'm happy to fix it with you on a quick call.

**Follow-up, once, after three days**

> No worries if not. Is there one paperwork job you'd pay to never do again? Curious either way.

## The call

Twenty minutes, screen shared, on their real files.

1. **Ask (3 minutes).** "Show me the last time you did this. How long did it take? What happens if
   it's wrong?" Write down their words. Those hours are the sale.
2. **Install (5 minutes).** Stay on with them through the warnings.
3. **Do the job (8 minutes).** Use their files. Let them read the result and find the mistakes.
   If it's wrong, say so and fix it with them. Watching it get corrected builds more trust than a
   clean demo.
4. **Schedule it.** "Want this to happen on the first of every month?" Save it together. This is
   the moment that predicts whether they stay.
5. **Ask for the money.** "That's $12 a month. Want to turn it on now?" Open the plan page and
   stay quiet. Most first sales are lost here, because the founder doesn't ask.

If they say "let me think", ask what they'd need to see. If they say no, ask why, then ask who
else they know.

## Answers to the usual objections

**"Why not ChatGPT, or Copilot, or Claude?"** Those are good, and for questions you should use
them. zWork is for the same job every month: it works on the files already on your computer,
hands back a real Excel or Word file, and does it again on a schedule. Don't claim it's smarter,
and don't call it the cheapest agent. ChatGPT Work has a free tier now.

**"Is my data safe?"** Say this accurately. Your files stay on your computer and aren't stored by
zWork. The parts the AI reads do go to the AI company doing the work, unless you run a local
model. Nothing gets sent or changed in another app until you approve it, and the code is public.
Never say "nothing leaves your computer" unless they're on a local model.

**"What if it gets something wrong?"** It will sometimes, so check the first few. It shows its
steps, and spreadsheets are checked for broken formulas before you get them. It won't catch a
wrong number in the source, which is why you read the first month's result with it.

**"Will it run when my laptop is off?"** No. Schedules run while zWork is open and the computer is
awake. If it missed a run, it says so.

## The numbers

These are guesses. Replace them with real ones after the first week.

| Step | Count | Assumption |
|---|---|---|
| Personal asks | 30 | One name per message, no bulk send |
| Replies | 12 | 40%, because they know you |
| Calls | 5 | 40% of replies have a job and a free slot |
| Pays on or after the call | 1–2 | 20–40% of calls, after watching it work on their files |

So 30 real asks should give one or two sales. Send ten a day and hold calls in the same week.
Log every ask, reply, call and result in the private sheet. Track the hours they said the job
took, and whether they saved a schedule.

## When to change course

Decide with evidence, not mood.

- **Under 8 replies from 30 asks:** the ask is wrong. Change the message or who you're asking.
- **People reply but won't book:** the job isn't painful enough. Ask about a different chore.
- **Calls happen but the job fails:** stop outreach and fix the product. This is the only result
  that sends you back to code.
- **The job works but nobody pays after 5 calls:** ask each of them what it's worth. If they say
  free is enough, Pro's limits or the offer are wrong. A $49 "I set it up for you" one-time fee is
  the next thing to try.
- **It works and one pays:** get them through the first month. Ask for an introduction, then
  repeat with that person's friends. Stick to whichever job sold.

## After the first sale

Check in after their first scheduled run and after two weeks. Their result tells you whether this
was a sale or a favor: they keep paying into month two, they haven't asked you to fix it, and they
mention it to someone. Hold off on ads, launches and new features until that has happened three
times.
