SELECT
	s.CurrentCrew, s.*
FROM
	FCT_MoveOrders as mo
inner join FCT_Ship as s on s.FleetID = mo.FleetID
WHERE
	mo.MoveActionID in (64,217)
AND
	mo.MoveOrder = 1
order by s.CurrentCrew