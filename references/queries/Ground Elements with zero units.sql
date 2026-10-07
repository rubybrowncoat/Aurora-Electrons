select * from
--delete from FCT_GroundUnitFormationElement where ElementID in

(
SELECT gufe.ElementID
--
/*
	,p.PopName
--	,f.FleetName
--	,s.ShipName
	,guf.Name
	,gufe.*
-- */
FROM
	vw_const as c
inner join FCT_GroundUnitFormation as guf on guf.RaceID = c.RaceID
inner join FCT_GroundUnitFormationElement as gufe on gufe.FormationID = guf.FormationID
inner join FCT_Population as p on p.PopulationID = guf.PopulationID
--left join fct_ship as s on s.ShipID = guf.ShipID
--left join fct_fleet as f on f.FleetID = s.FleetID
where gufe.Units = 0

and p.PopName = 'CAA-AAst19 ACADGrnd Prod/*'

order by
	p.PopName
--	,f.FleetName
--	,s.ShipName
)

--delete from FCT_GroundUnitFormationElement where ElementID = 11640