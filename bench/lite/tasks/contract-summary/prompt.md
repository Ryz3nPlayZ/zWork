My boss wants the key facts from our cleaning contract, `Service Agreement - Northwind.docx` in this folder. Today is 1 May 2026.

Write `contract-summary.json` with these fields:
- `client` and `provider`: the two companies' names
- `start_date`: when the service started (YYYY-MM-DD)
- `auto_renews`: true or false
- `renewal_notice_days`: how many days before the end of the term we must give notice to stop it renewing
- `termination_notice_days`: notice needed to end it early for convenience
- `current_monthly_fee`: what we pay per month now, as a number
- `late_interest_percent_per_month`: the late payment interest currently in force, as a number
- `payment_due_days`: how many days after the invoice payment is due

Then write `contract-summary.md`: a plain-English summary for my boss, 150 words at most.
