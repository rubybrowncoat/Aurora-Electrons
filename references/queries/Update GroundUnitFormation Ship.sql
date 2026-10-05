--select * from fct_ship as s where s.ShipName like 'Snakehead 016'

/*
SELECT
	s.ShipName, s.ShipID
	,s.*
FROM
	fct_fleet as f
inner JOIN fct_ship as s on s.FleetID = f.FleetID
WHERE
	f.FleetName = ' faa board7k | tgm* dip threads/strings Strikegroup'
order by s.ShipName
*/	
--select	
update FCT_GroundUnitFormation set shipid = 
	CASE
		when formationid= 2581 then 97817
		when formationid= 2582 then 97819
		when formationid= 2584 then 97824
		when formationid= 2585 then 97832
		when formationid= 2586 then 97838
		when formationid= 2588 then 97847
		when formationid= 2590 then 97854
		when formationid= 2592 then 97866
		when formationid= 2446 then 97476
		when formationid= 2447 then 97480
		when formationid= 2448 then 97485
		when formationid= 2449 then 97491
		when formationid= 2513 then 97639
		when formationid= 2515 then 97646
		when formationid= 2516 then 97656
		when formationid= 2517 then 97662
		when formationid= 2522 then 97766
		when formationid= 2523 then 97768
		when formationid= 2524 then 97789
		when formationid= 2525 then 97798
		else ShipID
	END
--from FCT_GroundUnitFormation
--where ShipID = 93989

