/*
SELECT
	*
FROM
	FCT_AlienClass as ac
left JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = ac.ActualClassID
WHERE
	sc.ShipClassID is null
*/	

-- select * from vw_const
	
SELECT
	--(2111390325.0 - c.LastUpdate) / 86400 as daysago	,
	*
-- delete
FROM
	FCT_Contacts where ContactType = 1 and ContactID not in (select ShipID from FCT_Ship)
