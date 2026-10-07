    SELECT
        m.name AS table_name,
        p.name AS column_name
    FROM
        sqlite_master AS m
    JOIN
        pragma_table_info(m.name) AS p
    WHERE
        m.type = 'table' AND p.name LIKE '%capital%'
	order by m.name