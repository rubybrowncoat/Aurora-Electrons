SELECT name
FROM sqlite_master
WHERE type = 'view' AND sql LIKE '%TotalAmount%'