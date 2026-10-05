select 
	sum(MiningModules) as  MiningModules
	,sum(Harvesters) as  Harvesters
	,sum(Terraformers) as  Terraformers
	,sum(MaintModules) as  MaintModules
from 
	vw_const as c
inner JOIN
	FCT_Fleet as f
on
	f.RaceID = c.RaceID
inner JOIN
	fct_ship as s
on
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
WHERE
	f.ShippingLine = 0