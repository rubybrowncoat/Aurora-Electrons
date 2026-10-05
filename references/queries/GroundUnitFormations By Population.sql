SELECT
	s.ShipName
	,sum(gufe.Units)
FROM
	fct_Ship as s
left JOIN	FCT_GroundUnitFormation as guf on guf.ShipID = s.ShipID
left JOIN	FCT_GroundUnitFormationElement as gufe on gufe.FormationID = guf.FormationID
inner join FCT_Fleet as f on f.FleetID = s.FleetID
WHERE
--	guf.Name like '% board%'
--AND
--	s.ShipName like 'oaf%'
--AND
	f.FleetName = '___ODF BEG-A2M9 03'

group by s.ShipName
order by 2, s.ShipName
