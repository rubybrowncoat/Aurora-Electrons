SELECT
	f.FleetName
	,o.MessageText
FROM
	FCT_Fleet as f
inner JOIN vw_const as c on c.RaceID = f.RaceID
inner JOIN
	FCT_MoveOrders as o
on
	o.FleetID = f.FleetID
AND
	o.MessageText <> ''
order by
	upper(f.FleetName)
	,o.MoveOrder