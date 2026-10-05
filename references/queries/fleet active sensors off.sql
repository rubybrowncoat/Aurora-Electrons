select 
	_shp.ShipName
	,_shp.ActiveSensorsOn
	,_shp.ShipID
	,*  --select count(*)
FROM 
	FCT_Fleet as _flt	
inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _flt.RaceID
inner JOIN
	FCT_Ship as _shp
on
	_shp.FleetID = _flt.FleetID
WHERE
	_flt.FleetName = '_Idle'
order by 
	_shp.ShipName
	
select count(*) from FCT_Ship where RaceID = (select max(RaceID) as RaceID from FCT_Race where NPR = 0) and ActiveSensorsOn = 1 --138
select count(*) from FCT_Ship where ActiveSensorsOn = 1 --167

/*	
begin TRANSACTION;
update FCT_Ship set ActiveSensorsOn = 0 where RaceID = (select max(RaceID) as RaceID from FCT_Race where NPR = 0)
update FCT_Ship set ActiveSensorsOn = 1 where ShipID =  
(	
	select 
		min(_shp.ShipID) as ShipID 
	from 
		FCT_Ship as _shp 
	inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = _shp.RaceID
	inner join 
		FCT_ShipClass as _cls 
	on 
		_cls.ShipClassID = _shp.ShipClassID 
	where 
		_cls.ActiveSensorStrength > 0 
	and 
		_shp.FleetID = FCT_Ship.FleetID
)
--inner JOIN (select max(RaceID) as RaceID from FCT_Race where NPR = 0) as CurrentRace on CurrentRace.RaceID = FCT_Ship.RaceID
--left join ( 
--	select FleetID,min(ShipID) as ShipID from FCT_Ship as _shp inner join FCT_ShipClass as _cls on _cls.ShipClassID = _shp.ShipClassID where _cls.ActiveSensorStrength > 0 group by FleetID
--) as x on x.FleetID = FCT_Ship.FleetID
	--where 
	--	shp.FleetID = 12203
	--AND
		--shp.ShipID <> 8371
*/		
--rollback
--commit
		



