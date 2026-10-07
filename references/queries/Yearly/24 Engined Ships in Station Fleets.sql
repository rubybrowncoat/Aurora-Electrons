select
-- this query returns all engined ships in any fleet designated as a gas, gate, sentinel or supply station
-- presumably these ships joined accidentally
	f.FleetName
	,s.ShipName
	,*
FROM
	FCT_Fleet as f
inner JOIN
	vw_const as c
on
	c.RaceID = f.RaceID
inner JOIN
	FCT_Ship as s
on 
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
AND
	sc.MaxSpeed > 1
WHERE
(
	f.FleetName like '%\_\_\_GAS%' Escape '\'
	or
	f.FleetName like '%\_\_\_GATE%' Escape '\'
	or
	f.FleetName like '%\_\_\_MNT%' Escape '\'
	or
	f.FleetName like '%\_\_\_sent%' Escape '\'
)
AND
	s.MothershipID = 0
	
	