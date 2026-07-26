# psycho-usage
פולר מכסות Claude. GitHub Actions מריץ `poll.mjs` כל 5 דקות, קורא usage אמיתי צד-שרת
מכל חשבון (לפי SESSION_KEYS secret) ומעדכן `usage.json`. הדשבורד קורא את `usage.json`.
