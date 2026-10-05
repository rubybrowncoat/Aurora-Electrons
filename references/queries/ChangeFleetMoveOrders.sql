select * from FCT_MoveOrders as mo where mo.FleetID = 142334

/*
update FCT_MoveOrders
set MoveActionID = 2, Description = Description || ' **Changed** : Move to location'
where FleetID = 142334
and MoveActionID = 12
*/