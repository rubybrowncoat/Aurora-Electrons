SELECT
	f.FleetName
	,s.ShipName
	,guf.Formations
FROM
	vw_const as c
inner join fct_ship as s on s.RaceID = c.RaceID
inner join fct_fleet as f on f.FleetID = s.FleetID
inner join (select guf.ShipID, count(guf.FormationID) as Formations from FCT_GroundUnitFormation as guf group by guf.ShipID) as guf on guf.ShipID = s.ShipID
inner join FCT_ShipClass as sc on sc.ShipClassID = s.ShipClassID
where sc.OtherRaceClassID > 0

order by 
	f.FleetName
	,s.ShipName