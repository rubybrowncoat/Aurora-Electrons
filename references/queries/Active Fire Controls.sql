SELECT
	*
FROM
	vw_const as c
inner JOIN
	fct_ship as s on s.RaceID = c.RaceID
inner JOIN
	FCT_FireControlAssignment as fca on fca.ShipID = s.ShipID
WHERE
	fca.OpenFire = 1