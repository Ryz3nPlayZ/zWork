I want to send our spring thank-you letter to our customers. The letter is `letter-template.md` and the customer list is `customers.csv`.

- Make one letter per customer in a `letters/` folder, named `First_Last.md` (for example `Maria_Gonzalez.md`), by filling in the placeholders in the template.
- The greeting is "Dear <title> <last name>," when the customer has a title, otherwise "Dear <first name>,".
- Don't write to anyone who has opted out or who has no email address, and don't send anyone two letters.
- Tidy up stray spaces in the names and other fields.
- Finally write `letters/sent.csv` with the columns `email,file` listing who gets a letter and the letter's file name, sorted by email.
