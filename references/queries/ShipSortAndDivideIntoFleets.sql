with CTE_Params as 
(
	SELECT
		'___ODF FIA-FIB -- tw%' as FleetName
)

,CTE_Ships as 
(
	SELECT
		s.ShipName
		,guf.Units
	from
		CTE_Params as p 
	inner JOIN fct_fleet as f on f.FleetName like p.FleetName
	inner join FCT_Ship as s on s.FleetID = f.FleetID
	left join 
	(
		select
			guf.ShipID, sum(gufe.Units) as Units
		FROM
			FCT_GroundUnitFormation as guf
		inner join (select gufe.FormationID, sum(gufe.Units) as Units from FCT_GroundUnitFormationElement as gufe group by gufe.FormationID) as gufe on gufe.FormationID = guf.FormationID
		group by guf.ShipID
	) as guf on guf.ShipID = s.ShipID
)

select * from CTE_Ships as s 
--where s.units >= 7
where s.shipname like 'oaf.b%'
order by 
	s.ShipName

/*
inner join fct_fleet as f on f.FleetID = s.FleetID
inner join CTE_Params as p on p.FleetName = f.FleetName
where s.ShipName not in (select ShipName from CTE_Ships)
*/
/*
update fct_ship 
	set FleetID = 893263
WHERE
	ShipName in (
		'Oaf 001'
	)
*/
	
	
/*	
FleetID	FleetName
893268	___ODF FIA-FIB -- cheetah
893263	___ODF FIA-FIB -- highland
893267	___ODF FIA-FIB -- lynx
893264	___ODF FIA-FIB -- wild 1
893265	___ODF FIA-FIB -- wild 2
893266	___ODF FIA-FIB -- wild 3
*/
