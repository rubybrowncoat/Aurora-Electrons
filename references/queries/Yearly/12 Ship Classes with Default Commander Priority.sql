SELECT
	sc.noofficers
	,*
FROM
	vw_const as c
inner JOIN
	FCT_ShipClass as sc
on
	sc.RaceID = c.RaceID
WHERE
	sc.CommanderPriority = 5
AND
	sc.ClassShippingLineID = 0
AND
	sc.NoOfficers = 0